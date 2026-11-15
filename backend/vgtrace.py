"""DigInside: trace the real machine code's memory accesses with Valgrind (lackey).

Any C/C++ program, no tarray needed. Pipeline:
  1. build with the program's build command plus `-g -no-pie` (debug info for source lines; fixed
     addresses for globals, so traces are repeatable)
  2. run under `valgrind --tool=lackey --trace-mem=yes` with heapshim.so preloaded, which logs every
     malloc/calloc/realloc so heap blocks can be labeled
  3. keep, by default, only accesses made by the program's own code: lackey prints each instruction
     (`I addr,size`) before the loads/stores it makes (` L`, ` S`, ` M` = load+store), so accesses whose
     instruction lies outside the executable's .text (dynamic loader, libc, printf internals) or in C
     runtime startup functions are dropped
  4. label addresses with names from the debug info: global variables, and local variables of each
     function call (a `call` stores the return address just below the frame's CFA, so the store right
     before a function's first instruction pins down that call's frame); heap blocks from the heap log
     (named by the source line that called malloc); then sections / other / unnamed stack
  5. map each instruction to file:line with addr2line, so every access shows the source line that made it
"""
from __future__ import annotations

import os
import re
import shlex
import subprocess
import tempfile
from pathlib import Path

import workspace
from cache_sim import Trace

INSTRUMENT = Path(__file__).resolve().parent.parent / "instrument"
SHIM_SRC = INSTRUMENT / "heapshim.c"
SHIM_SO = INSTRUMENT / ".build" / "heapshim.so"
RUN_TIMEOUT_S = 60
STARTUP_FUNCS = {
    "_start", "_dl_relocate_static_pie", "deregister_tm_clones", "register_tm_clones",
    "__do_global_dtors_aux", "frame_dummy", "_init", "_fini", "__libc_csu_init", "__libc_csu_fini",
}
STACK_FLOOR = 0x1000000000  # Valgrind puts the client stack near 0x1ffefff000; heap/globals sit far below


class VgError(ValueError):
    pass


def _type_info(die, depth: int = 0) -> tuple[int, int]:
    """(total byte size, element byte size) of a DWARF type DIE; arrays report their element size."""
    if die is None or depth > 25:
        return 0, 0
    tag = die.tag
    if tag in ("DW_TAG_pointer_type", "DW_TAG_reference_type", "DW_TAG_rvalue_reference_type"):
        return 8, 8
    if tag == "DW_TAG_array_type":
        esize, eelem = _type_info(die.get_DIE_from_attribute("DW_AT_type"), depth + 1) if "DW_AT_type" in die.attributes else (0, 0)
        count = 1
        for c in die.iter_children():
            if c.tag != "DW_TAG_subrange_type":
                continue
            a = c.attributes
            if "DW_AT_count" in a and isinstance(a["DW_AT_count"].value, int):
                count *= a["DW_AT_count"].value
            elif "DW_AT_upper_bound" in a and isinstance(a["DW_AT_upper_bound"].value, int):
                count *= a["DW_AT_upper_bound"].value + 1
            else:
                return 0, 0  # variable-length array
        return esize * count, eelem or esize
    if "DW_AT_byte_size" in die.attributes and isinstance(die.attributes["DW_AT_byte_size"].value, int):
        sz = die.attributes["DW_AT_byte_size"].value
        return sz, sz
    if "DW_AT_type" in die.attributes:
        return _type_info(die.get_DIE_from_attribute("DW_AT_type"), depth + 1)
    return 0, 0


def _dwarf_vars(exe: str):
    """Globals [(addr, size, elem, name)] and functions {entry_pc: (name, [(var, cfa_offset, size, elem)])}
    for variables whose address is fixed (DW_OP_addr) or frame-relative (DW_OP_fbreg)."""
    from elftools.dwarf.dwarf_expr import DWARFExprParser
    from elftools.elf.elffile import ELFFile

    globals_: list[tuple[int, int, int, str]] = []
    funcs: dict[int, tuple[str, list[tuple[str, int, int, int]]]] = {}
    with open(exe, "rb") as f:
        elf = ELFFile(f)
        if not elf.has_dwarf_info():
            return globals_, funcs
        dw = elf.get_dwarf_info()
        parser = DWARFExprParser(dw.structs)

        def loc(die):
            a = die.attributes.get("DW_AT_location")
            if a is None or a.form not in ("DW_FORM_exprloc", "DW_FORM_block1"):
                return None
            try:
                ops = parser.parse_expr(a.value)
            except Exception:  # noqa: BLE001 - unusual expressions: just skip the variable
                return None
            return ops[0] if len(ops) == 1 else None

        def name_of(die):
            a = die.attributes.get("DW_AT_name")
            return a.value.decode(errors="replace") if a else None

        def collect_locals(die, out):
            for c in die.iter_children():
                if c.tag in ("DW_TAG_variable", "DW_TAG_formal_parameter"):
                    op, nm = loc(c), name_of(c)
                    if op is not None and op.op_name == "DW_OP_fbreg" and nm and "DW_AT_type" in c.attributes:
                        size, elem = _type_info(c.get_DIE_from_attribute("DW_AT_type"))
                        if size > 0:
                            out.append((nm, op.args[0], size, elem))
                elif c.tag == "DW_TAG_lexical_block":
                    collect_locals(c, out)

        for cu in dw.iter_CUs():
            for die in cu.iter_DIEs():
                if die.tag == "DW_TAG_variable" and die.get_parent() is not None and die.get_parent().tag == "DW_TAG_compile_unit":
                    op, nm = loc(die), name_of(die)
                    if op is not None and op.op_name == "DW_OP_addr" and nm and "DW_AT_type" in die.attributes:
                        size, elem = _type_info(die.get_DIE_from_attribute("DW_AT_type"))
                        if size > 0:
                            globals_.append((op.args[0], size, elem, nm))
                elif die.tag == "DW_TAG_subprogram" and "DW_AT_low_pc" in die.attributes:
                    fb = die.attributes.get("DW_AT_frame_base")
                    try:
                        fb_ops = parser.parse_expr(fb.value) if fb is not None else []
                    except Exception:  # noqa: BLE001
                        fb_ops = []
                    if not fb_ops or fb_ops[0].op_name != "DW_OP_call_frame_cfa":
                        continue  # only CFA-based frames (gcc's default on x86-64)
                    vars_: list[tuple[str, int, int, int]] = []
                    collect_locals(die, vars_)
                    if vars_:
                        funcs[die.attributes["DW_AT_low_pc"].value] = (name_of(die) or "?", vars_)
    return sorted(globals_), funcs


def available() -> bool:
    try:
        return subprocess.run(["valgrind", "--version"], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _shim() -> str:
    if not SHIM_SO.exists() or SHIM_SO.stat().st_mtime < SHIM_SRC.stat().st_mtime:
        SHIM_SO.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(["gcc", "-O2", "-shared", "-fPIC", str(SHIM_SRC), "-o", str(SHIM_SO)],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise VgError(f"could not build heapshim: {r.stderr.strip()}")
    return str(SHIM_SO)


def _text_range(exe: str) -> tuple[int, int]:
    out = subprocess.run(["readelf", "-SW", exe], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if " .text " in line:
            p = line.split()
            i = p.index(".text")
            addr, size = int(p[i + 2], 16), int(p[i + 4], 16)
            return addr, addr + size
    raise VgError("no .text section in the executable")


def _data_sections(exe: str) -> list[tuple[int, int, str]]:
    """(base, size, name) of allocated, non-executable sections (.rodata, .data, .bss, .got, ...)."""
    out = subprocess.run(["readelf", "-SW", exe], capture_output=True, text=True).stdout
    secs = []
    for line in out.splitlines():
        m = re.match(r"\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)\s+\S+\s+(\S*)", line)
        if not m:
            continue
        name, addr, size, flags = m.group(1), int(m.group(2), 16), int(m.group(3), 16), m.group(4)
        if addr and size and "A" in flags and "X" not in flags:
            secs.append((addr, size, name))
    return sorted(secs)


def _data_symbols(exe: str) -> list[tuple[int, int, str]]:
    """(base, size, name) of global/static data objects, demangled."""
    out = subprocess.run(["nm", "-S", "-C", "--defined-only", exe], capture_output=True, text=True).stdout
    syms = []
    for line in out.splitlines():
        p = line.split(maxsplit=3)
        if len(p) == 4 and p[2] in "bBdDrRgGsS" and len(p[2]) == 1:
            size = int(p[1], 16)
            if size > 0:
                syms.append((int(p[0], 16), size, p[3]))
    return sorted(syms)


def _addr2line(exe: str, ips: list[int], prefer: str) -> dict[int, tuple[str, int, str]]:
    """ip -> (file, line, function). With inlining, prefer the frame in the user's source file."""
    if not ips:
        return {}
    r = subprocess.run(["addr2line", "-a", "-f", "-C", "-i", "-e", exe], input="\n".join(hex(i) for i in ips),
                       capture_output=True, text=True, timeout=60)
    res: dict[int, tuple[str, int, str]] = {}
    cur, frames = None, []

    def flush():
        if cur is None:
            return
        pick = next((f for f in frames if os.path.basename(f[0]) == prefer), frames[0] if frames else ("??", 0, "??"))
        res[cur] = pick

    lines = r.stdout.splitlines()
    i = 0
    while i < len(lines):
        l = lines[i]
        if l.startswith("0x"):
            flush()
            cur, frames = int(l, 16), []
            i += 1
            continue
        func = l
        loc = lines[i + 1] if i + 1 < len(lines) else "??:0"
        file, _, ln = loc.rpartition(":")
        m = re.match(r"\d+", ln)
        frames.append((file, int(m.group()) if m else 0, func))
        i += 2
    flush()
    return res


def trace(rel: str, argv_args: list[str], scope: str, max_accesses: int, build_template: str | None) -> dict:
    """Build + run under Valgrind; returns {"build", "run", "trace": Trace} (trace None on failure)."""
    src = workspace.resolve(rel)
    lang = workspace.LANGS[src.suffix.lower()]
    if lang not in ("c", "cpp") or src.suffix.lower() not in workspace.RUNNABLE:
        raise VgError("Valgrind tracing needs a C or C++ program")
    if not available():
        raise VgError("valgrind is not installed (sudo apt install valgrind)")

    template = (build_template or workspace.DEFAULT_BUILD[lang]).replace("-fopenmp", "")
    for flag in ("-g", "-no-pie"):  # debug info for source lines; fixed addresses for repeatable traces
        if flag not in shlex.split(template):
            template += " " + flag
    import asyncio  # build() is async; we're already in a worker thread
    b = asyncio.run(workspace.build(rel, template))
    if not b["ok"]:
        return {"build": b, "run": None, "trace": None}
    exe = b["argv"][0]

    with tempfile.TemporaryDirectory(prefix="diginside-vg-") as tmp:
        log, heaplog = os.path.join(tmp, "lackey.txt"), os.path.join(tmp, "heap.txt")
        env = {**os.environ, "LD_PRELOAD": _shim(), "DIGINSIDE_HEAPLOG": heaplog}
        cmd = ["valgrind", "--tool=lackey", "--trace-mem=yes", f"--log-file={log}", exe, *argv_args]
        try:
            p = subprocess.run(cmd, env=env, cwd=str(workspace.WORKSPACE), stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=RUN_TIMEOUT_S, close_fds=True)
            code, out = p.returncode, p.stdout.decode(errors="replace")
        except subprocess.TimeoutExpired:
            raise VgError(f"the program ran longer than {RUN_TIMEOUT_S} s under Valgrind (it is ~50x slower); "
                          "try smaller arguments")
        run = {"code": code, "output": "\n".join(out.splitlines()[:200]), "ms": 0, "cached": False,
               "cmd": "valgrind --tool=lackey --trace-mem=yes " + shlex.join([os.path.basename(exe), *argv_args])}

        lo, hi = _text_range(exe)
        try:
            dwarf_globals, dwarf_funcs = _dwarf_vars(exe)
        except Exception:  # noqa: BLE001 - no/odd debug info: fall back to symbol names only
            dwarf_globals, dwarf_funcs = [], {}
        ops: list[int] = []
        addrs: list[int] = []
        sizes: list[int] = []
        ipl: list[int] = []
        seqs: list[int] = []  # position of each kept access in the full access stream
        frame_entries: dict[tuple[int, int], list[int]] = {}  # (entry pc, CFA) -> stream positions it was entered at
        total = 0
        truncated = False
        ip = 0
        last_store = None
        with open(log, errors="replace") as f:
            for line in f:
                c0 = line[:1]
                if c0 == "I":
                    ip = int(line[3:line.index(",")], 16)
                    if ip in dwarf_funcs and last_store is not None:
                        # the call that got us here just pushed the return address at CFA - 8
                        key = (ip, last_store + 8)
                        if key in frame_entries or len(frame_entries) < 500:
                            frame_entries.setdefault(key, []).append(total)
                    continue
                if c0 != " ":
                    continue
                kind = line[1:2]
                if kind not in ("L", "S", "M"):
                    continue
                total += 1
                if kind == "S":
                    last_store = int(line[3:line.index(",")], 16)
                if scope == "code" and not (lo <= ip < hi):
                    continue
                if len(ops) >= max_accesses:
                    truncated = True
                    continue
                a, _, sz = line[3:].strip().partition(",")
                addr, size = int(a, 16), int(sz or 1)
                if kind == "M":  # read-modify-write: one load and one store
                    ops += [0, 1]; addrs += [addr, addr]; sizes += [size, size]; ipl += [ip, ip]; seqs += [total, total]
                else:
                    ops.append(1 if kind == "S" else 0); addrs.append(addr); sizes.append(size); ipl.append(ip); seqs.append(total)
        heap = []
        try:
            with open(heaplog) as f:
                for line in f:
                    p_ = line.split()
                    if len(p_) >= 3:
                        heap.append((int(p_[1], 16), int(p_[2]), int(p_[3], 16) if len(p_) > 3 else 0))
        except FileNotFoundError:
            pass

    # source lines for every instruction that made a kept access (and for every malloc call site)
    uniq = sorted(set(ipl) | {h[2] - 1 for h in heap if lo <= h[2] < hi})
    where = _addr2line(exe, uniq, src.name)
    if scope == "code":
        keep = [i for i in range(len(ops)) if where.get(ipl[i], ("", 0, ""))[2] not in STARTUP_FUNCS]
        ops = [ops[i] for i in keep]; addrs = [addrs[i] for i in keep]; sizes = [sizes[i] for i in keep]
        ipl = [ipl[i] for i in keep]; seqs = [seqs[i] for i in keep]

    src_text = src.read_text(errors="replace").splitlines()
    line_index: dict[tuple, int] = {}
    lines_tab: list[dict] = []
    line_ids: list[int] = []
    for ip_ in ipl:
        file, ln, func = where.get(ip_, ("??", 0, "??"))
        key = (file, ln, func)
        if key not in line_index:
            text = src_text[ln - 1].strip() if os.path.basename(file) == src.name and 0 < ln <= len(src_text) else ""
            line_index[key] = len(lines_tab)
            lines_tab.append({"file": os.path.basename(file), "line": ln, "func": func, "text": text})
        line_ids.append(line_index[key])

    # name the memory: globals from the symbol table, heap blocks from the heap log, then the stack
    syms = _data_symbols(exe)
    secs = _data_sections(exe)
    # local variables: one interval per (call frame, variable); a frame = (function entry pc, CFA)
    func_frames: dict[int, list[tuple[int, int]]] = {}
    for (pc, cfa) in frame_entries:
        func_frames.setdefault(pc, []).append((pc, cfa))
    local_iv: list[tuple[int, int, tuple, str, int, str]] = []  # (lo, hi, frame, name, elem, func)
    for pc, frames in func_frames.items():
        fname, vars_ = dwarf_funcs[pc]
        frames.sort(key=lambda fr: frame_entries[fr][0])
        for k, fr in enumerate(frames):
            prefix = "" if fname == "main" and len(frames) == 1 else (f"{fname}." if len(frames) == 1 else f"{fname}#{k + 1}.")
            for vname, off, size, elem in vars_:
                local_iv.append((fr[1] + off, fr[1] + off + size, fr, prefix + vname, elem, fname))
    import bisect

    def local_for(a: int, seq: int):
        """The variable of the most recently entered frame (before this access) that covers address a."""
        best, best_t = None, -1
        for lo_, hi_, fr, nm, elem, fname in local_iv:
            if lo_ <= a < hi_:
                times = frame_entries[fr]
                i = bisect.bisect_right(times, seq) - 1
                if i >= 0 and times[i] > best_t:
                    best, best_t = (lo_, hi_, fr, nm, elem, fname), times[i]
        return best

    heap_line = {}
    for hb, hs, ra in heap:
        w = where.get(ra - 1) if lo <= ra < hi else None
        heap_line[hb] = w[1] if w and os.path.basename(w[0]) == src.name else 0
    regions: list[dict] = []
    seen_region: dict[tuple, int] = {}
    min_size: dict[tuple, int] = {}
    span: dict[int, list[int]] = {}  # region index -> [lowest, highest+size) actually accessed
    stack_lo = stack_hi = None
    heap_n = 0
    descs: dict[tuple, str] = {}
    for a, sz, seq in zip(addrs, sizes, seqs):
        key = None
        if a >= STACK_FLOOR and local_iv:
            hit = local_for(a, seq)
            if hit:
                key = ("local", hit[3], hit[0], hit[1] - hit[0], hit[4])
                descs[key] = f"local variable of {hit[5]}()"
        if key is None and a < STACK_FLOOR:
            for base, size, elem, name in dwarf_globals:
                if base <= a < base + size:
                    key = ("global", name, base, size, elem)
                    descs[key] = "global variable"
                    break
        if key is None:
            for base, size, name in syms:
                if base <= a < base + size:
                    key = ("global", name, base, size)
                    descs[key] = "global variable"
                    break
        if key is None and a < STACK_FLOOR:
            for hb, hs, _ra in reversed(heap):  # latest allocation covering the address
                if hb <= a < hb + max(hs, 1):
                    key = ("heap", hb, hb, hs)
                    ln = heap_line.get(hb, 0)
                    descs[key] = f"heap block from malloc/new on line {ln}" if ln else "heap block (malloc/new)"
                    break
        if key is None and a < STACK_FLOOR:
            for base, size, name in secs:  # unnamed data inside the executable, e.g. constants in .rodata
                if base <= a < base + size:
                    key = ("section", name, base, size)
                    break
        if key is None and a < STACK_FLOOR:  # outside the program: thread-local storage, libraries, ...
            page = a & ~0xFFF
            key = ("other", "other", page, 0x1000)
        if key is None:
            if a >= STACK_FLOOR:
                stack_lo = a if stack_lo is None else min(stack_lo, a)
                stack_hi = a + sz if stack_hi is None else max(stack_hi, a + sz)
            continue
        if key not in seen_region:
            seen_region[key] = len(regions)
            kind = key[0]
            if kind == "heap":
                heap_n += 1
                name = f"heap#{heap_n}"
            else:
                name = key[1]
            # element size: from the debug info when known, else the smallest access seen
            elem = key[4] if len(key) > 4 and key[4] else sz
            regions.append({"name": name, "base": key[2], "bytes": key[3], "elem": elem, "kind": kind,
                            "desc": descs.get(key, ""), "known_elem": len(key) > 4 and bool(key[4])})
            min_size[key] = sz
        elif not regions[seen_region[key]].get("known_elem") and sz < min_size[key]:
            min_size[key] = sz
            regions[seen_region[key]]["elem"] = sz
        sp = span.setdefault(seen_region[key], [a, a + sz])
        sp[0], sp[1] = min(sp[0], a), max(sp[1], a + sz)
    # Unnamed memory (a section, or a page outside the program): show only the part that was touched.
    for i, reg in enumerate(regions):
        if reg["kind"] in ("section", "other") and i in span:
            lo_, hi_ = span[i][0] & ~15, (span[i][1] + 15) & ~15
            reg["base"], reg["bytes"] = lo_, hi_ - lo_
    if stack_lo is not None:
        base = stack_lo & ~63
        regions.append({"name": "stack", "base": base, "bytes": stack_hi - base, "elem": 1, "kind": "stack",
                        "desc": "stack memory without a named variable (saved registers, return addresses, temporaries)"})
    for reg in regions:
        reg.pop("known_elem", None)
        if reg["kind"] == "section":
            reg["desc"] = f"unnamed data in the program's {reg['name']} section (e.g. constants the compiler made)"
        elif reg["kind"] == "other":
            reg["desc"] = "memory outside your program (C library data, thread-local storage)"
    regions.sort(key=lambda r: r["base"])

    note = (f"Valgrind traced {total} loads/stores; kept {len(ops)} made by your code"
            if scope == "code" else f"Valgrind traced {total} loads/stores (everything, including startup and libraries)")
    if truncated:
        note += f" (cut off at {max_accesses})"
    t = Trace(ops=ops, addrs=addrs, sizes=sizes, marks=[], regions=regions, truncated=truncated,
              line_ids=line_ids, lines=lines_tab, note=note)
    return {"build": b, "run": run, "trace": t}

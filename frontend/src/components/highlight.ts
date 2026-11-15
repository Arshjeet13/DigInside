// Tiny dependency-free syntax highlighter for C/C++, Python and shell.
export type Tok = { t: "kw" | "type" | "str" | "com" | "num" | "pre" | "fn" | "txt"; s: string };

const CPP_KW = "alignas alignof auto break case catch class const constexpr consteval continue co_await co_return co_yield decltype default delete do else enum explicit export extern false for friend goto if inline mutable namespace new noexcept nullptr operator private protected public register return sizeof static static_assert static_cast dynamic_cast reinterpret_cast const_cast struct switch template this thread_local throw true try typedef typename union using virtual volatile while";
const CPP_TYPES = "bool char double float int long short signed unsigned void size_t ssize_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t uintptr_t std vector string thread mutex atomic";
const PY_KW = "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield";
const PY_TYPES = "int float str list dict set tuple bool bytes object range print len self";
const SH_KW = "if then else elif fi for while do done case esac in function return export local echo exit";

const set = (s: string) => new Set(s.split(" "));
const LANG = {
  cpp: { kw: set(CPP_KW), types: set(CPP_TYPES), line: "//", block: true, hashPre: true },
  c: { kw: set(CPP_KW), types: set(CPP_TYPES), line: "//", block: true, hashPre: true },
  python: { kw: set(PY_KW), types: set(PY_TYPES), line: "#", block: false, hashPre: false },
  shell: { kw: set(SH_KW), types: new Set<string>(), line: "#", block: false, hashPre: false },
};

export function tokenize(src: string, lang: keyof typeof LANG): Tok[] {
  const L = LANG[lang] ?? LANG.cpp;
  const out: Tok[] = [];
  let i = 0;
  const push = (t: Tok["t"], s: string) => out.push({ t, s });
  const atLineStart = () => {
    let j = i - 1;
    while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
    return j < 0 || src[j] === "\n";
  };
  while (i < src.length) {
    const c = src[i];
    const rest = src.startsWith.bind(src);
    if (L.hashPre && c === "#" && atLineStart()) {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? src.length : e;
      push("pre", src.slice(i, end));
      i = end;
    } else if (rest(L.line, i)) {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? src.length : e;
      push("com", src.slice(i, end));
      i = end;
    } else if (L.block && rest("/*", i)) {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? src.length : e + 2;
      push("com", src.slice(i, end));
      i = end;
    } else if (lang === "python" && (rest('"""', i) || rest("'''", i))) {
      const q = src.slice(i, i + 3);
      const e = src.indexOf(q, i + 3);
      const end = e < 0 ? src.length : e + 3;
      push("str", src.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      push("str", src.slice(i, j + 1));
      i = j + 1;
    } else if (/[0-9]/.test(c)) {
      const m = /^(0x[0-9a-fA-F']+|[0-9][0-9_'.]*(e[+-]?\d+)?)[uUlLfF]*/.exec(src.slice(i))!;
      push("num", m[0]);
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      const w = m[0];
      const next = src.slice(i + w.length).match(/^\s*\(/);
      push(L.kw.has(w) ? "kw" : L.types.has(w) ? "type" : next ? "fn" : "txt", w);
      i += w.length;
    } else {
      const m = /^[^A-Za-z0-9_"'#/]+|^./s.exec(src.slice(i))!;
      push("txt", m[0]);
      i += m[0].length;
    }
  }
  return out;
}

/** Split tokens into lines (tokens may span lines, e.g. block comments). */
export function toLines(toks: Tok[]): Tok[][] {
  const lines: Tok[][] = [[]];
  for (const tok of toks) {
    const parts = tok.s.split("\n");
    parts.forEach((p, k) => {
      if (k > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ t: tok.t, s: p });
    });
  }
  return lines;
}

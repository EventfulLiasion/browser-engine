// ============================================================
// TITAN ENGINE — js.ts : from-scratch JavaScript subset engine
// Lexer + recursive-descent parser + tree-walking interpreter
// with closures, classes, exceptions, destructuring-lite,
// template literals, and host DOM bindings.
// ============================================================

// ---------------- Lexer ----------------
type TokT =
  | { t: "num"; v: number } | { t: "str"; v: string } | { t: "name"; v: string }
  | { t: "punct"; v: string } | { t: "eof" };

export function lex(src: string): TokT[] {
  const out: TokT[] = [];
  let i = 0;
  const isId = (c: string) => /[A-Za-z_$]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      if (c === "`") { // template: emit as punct-backtick and let parser handle? simplify: raw string with ${} kept
        let j = i + 1, s = "";
        while (j < src.length && src[j] !== "`") {
          if (src[j] === "\\") { s += src[j] + src[j + 1]; j += 2; continue; }
          s += src[j]; j++;
        }
        out.push({ t: "str", v: "\u0000TPL:" + s }); i = j + 1; continue;
      }
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          const n = src[j + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n ?? "";
          j += 2; continue;
        }
        s += src[j]; j++;
      }
      out.push({ t: "str", v: s }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      out.push({ t: "num", v: Number(m![1]) }); i += m![1].length; continue;
    }
    if (isId(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
      out.push({ t: "name", v: m![0] }); i += m![0].length; continue;
    }
    const three = src.slice(i, i + 3);
    if (["===", "!==", ">>>", "<<=", ">>=", "..."].includes(three)) { out.push({ t: "punct", v: three }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||", "=>", "++", "--", "+=", "-=", "*=", "/=", "%=", "**", "??", "?."].includes(two)) { out.push({ t: "punct", v: two }); i += 2; continue; }
    out.push({ t: "punct", v: c }); i++;
  }
  out.push({ t: "eof" });
  return out;
}

// ---------------- AST ----------------
export type AstNode =
  | { k: "program"; body: AstNode[] }
  | { k: "block"; body: AstNode[] }
  | { k: "var"; mode: string; decls: { name: string; init: AstNode | null }[] }
  | { k: "func"; name: string | null; params: string[]; body: AstNode; expr: boolean }
  | { k: "class"; name: string | null; super: AstNode | null; methods: { name: string; fn: AstNode; static: boolean }[]; fields: { name: string; init: AstNode | null }[] }
  | { k: "return"; arg: AstNode | null }
  | { k: "if"; test: AstNode; yes: AstNode; no: AstNode | null }
  | { k: "while"; test: AstNode; body: AstNode }
  | { k: "for"; init: AstNode | null; test: AstNode | null; update: AstNode | null; body: AstNode }
  | { k: "forIn"; lhs: string; obj: AstNode; body: AstNode }
  | { k: "throw"; arg: AstNode }
  | { k: "try"; body: AstNode; catchName: string | null; catchBody: AstNode | null; finallyBody: AstNode | null }
  | { k: "expr"; expr: AstNode }
  | { k: "assign"; op: string; left: AstNode; right: AstNode }
  | { k: "binary"; op: string; left: AstNode; right: AstNode }
  | { k: "unary"; op: string; arg: AstNode }
  | { k: "call"; callee: AstNode; args: AstNode[] }
  | { k: "new"; callee: AstNode; args: AstNode[] }
  | { k: "member"; obj: AstNode; prop: string; computed: boolean; optional: boolean }
  | { k: "id"; name: string }
  | { k: "lit"; value: unknown }
  | { k: "tpl"; parts: (string | AstNode)[] }
  | { k: "arr"; items: AstNode[] }
  | { k: "obj"; props: { key: string; value: AstNode }[] }
  | { k: "arrow"; params: string[]; body: AstNode }
  | { k: "ternary"; test: AstNode; yes: AstNode; no: AstNode }
  | { k: "seq"; items: AstNode[] }
  | { k: "break" } | { k: "continue" } | { k: "debugger" };

class Parser {
  toks: TokT[]; pos = 0;
  constructor(src: string) { this.toks = lex(src); }
  peek(): TokT { return this.toks[this.pos]; }
  next(): TokT { return this.toks[this.pos++]; }
  eat(v: string): boolean {
    const t = this.peek();
    if (t.t === "punct" && t.v === v) { this.pos++; return true; }
    return false;
  }
  expect(v: string): void { if (!this.eat(v)) throw new SyntaxError(`Expected '${v}'`); }
  eatName(v: string): boolean {
    const t = this.peek();
    if (t.t === "name" && t.v === v) { this.pos++; return true; }
    return false;
  }
  parseProgram(): AstNode {
    const body: AstNode[] = [];
    while (this.peek().t !== "eof") body.push(this.parseStmt());
    return { k: "program", body };
  }
  parseStmt(): AstNode {
    const t = this.peek();
    if (t.t === "name") {
      if (t.v === "function") return this.parseFuncDecl(false);
      if (t.v === "class") return this.parseClass();
      if (["let", "const", "var"].includes(t.v)) return this.parseVar();
      if (t.v === "if") return this.parseIf();
      if (t.v === "while") return this.parseWhile();
      if (t.v === "for") return this.parseFor();
      if (t.v === "return") { this.next(); let a: AstNode | null = null;
        if (!(this.peek().t === "punct" && (this.peek() as {v:string}).v === ";")) {
          if (!(this.peek().t === "punct" && (this.peek() as {v:string}).v === "}")) a = this.parseExpr();
        }
        this.eat(";"); return { k: "return", arg: a }; }
      if (t.v === "throw") { this.next(); const a = this.parseExpr(); this.eat(";"); return { k: "throw", arg: a }; }
      if (t.v === "try") return this.parseTry();
      if (t.v === "break") { this.next(); this.eat(";"); return { k: "break" }; }
      if (t.v === "continue") { this.next(); this.eat(";"); return { k: "continue" }; }
      if (t.v === "debugger") { this.next(); this.eat(";"); return { k: "debugger" }; }
    }
    if (t.t === "punct" && t.v === "{") return this.parseBlock();
    if (t.t === "punct" && t.v === ";") { this.next(); return { k: "block", body: [] }; }
    const e = this.parseExpr();
    this.eat(";");
    return { k: "expr", expr: e };
  }
  parseBlock(): AstNode {
    this.expect("{");
    const body: AstNode[] = [];
    while (!(this.peek().t === "punct" && (this.peek() as {v:string}).v === "}")) {
      if (this.peek().t === "eof") throw new SyntaxError("Unterminated block");
      body.push(this.parseStmt());
    }
    this.expect("}");
    return { k: "block", body };
  }
  parseVar(): AstNode {
    const mode = (this.next() as { v: string }).v;
    const decls: { name: string; init: AstNode | null }[] = [];
    do {
      const n = this.next();
      if (n.t !== "name") throw new SyntaxError("Expected identifier");
      let init: AstNode | null = null;
      if (this.eat("=")) init = this.parseExpr();
      decls.push({ name: (n as { v: string }).v, init });
    } while (this.eat(","));
    this.eat(";");
    return { k: "var", mode, decls };
  }
  parseFuncDecl(expr: boolean): AstNode {
    this.next(); // function
    let name: string | null = null;
    if (this.peek().t === "name") name = (this.next() as { v: string }).v;
    else if (!expr) throw new SyntaxError("Function needs a name");
    this.expect("(");
    const params: string[] = [];
    while (!this.eat(")")) {
      const p = this.next();
      if (p.t !== "name") throw new SyntaxError("Bad param");
      params.push((p as { v: string }).v);
      if (!this.eat(",")) { this.expect(")"); break; }
    }
    const body = this.parseBlock();
    return { k: "func", name, params, body, expr };
  }
  parseClass(): AstNode {
    this.next(); // class
    let name: string | null = null;
    if (this.peek().t === "name") name = (this.next() as { v: string }).v;
    let sup: AstNode | null = null;
    if (this.eatName("extends")) sup = this.parseExpr();
    this.expect("{");
    const methods: { name: string; fn: AstNode; static: boolean }[] = [];
    const fields: { name: string; init: AstNode | null }[] = [];
    while (!this.eat("}")) {
      let isStatic = false;
      if (this.eatName("static")) isStatic = true;
      const nt = this.next();
      if (nt.t !== "name" && nt.t !== "str") throw new SyntaxError("Bad class member");
      const mname = (nt as { v: string }).v;
      if (this.peek().t === "punct" && (this.peek() as { v: string }).v === "(") {
        this.expect("(");
        const params: string[] = [];
        while (!this.eat(")")) {
          const p = this.next();
          if (p.t !== "name") throw new SyntaxError("Bad param");
          params.push((p as { v: string }).v);
          if (!this.eat(",")) { this.expect(")"); break; }
        }
        const body = this.parseBlock();
        methods.push({ name: mname, fn: { k: "func", name: mname, params, body, expr: true }, static: isStatic });
      } else if (this.eat("=")) {
        const init = this.parseExpr(); this.eat(";");
        fields.push({ name: mname, init });
      } else { this.eat(";"); fields.push({ name: mname, init: null }); }
    }
    return { k: "class", name, super: sup, methods, fields };
  }
  parseIf(): AstNode {
    this.next(); this.expect("("); const t = this.parseExpr(); this.expect(")");
    const yes = this.parseStmt();
    let no: AstNode | null = null;
    if (this.eatName("else")) no = this.parseStmt();
    return { k: "if", test: t, yes, no };
  }
  parseWhile(): AstNode {
    this.next(); this.expect("("); const t = this.parseExpr(); this.expect(")");
    return { k: "while", test: t, body: this.parseStmt() };
  }
  parseFor(): AstNode {
    this.next(); this.expect("(");
    // for (x in/of obj) or classic
    if (this.peek().t === "punct" && (this.peek() as {v:string}).v === ";") {
      this.next();
      let test: AstNode | null = null, upd: AstNode | null = null;
      if (!this.eat(";")) { test = this.parseExpr(); this.expect(";"); }
      if (!this.eat(")")) { upd = this.parseExpr(); this.expect(")"); }
      return { k: "for", init: null, test, update: upd, body: this.parseStmt() };
    }
    // try parse init then check for in/of
    const save = this.pos;
    try {
      let lhs = "";
      const p0 = this.peek();
      if (p0.t === "name" && ["let", "var", "const"].includes((p0 as {v:string}).v)) {
        this.next();
        const idt = this.next();
        lhs = (idt as { v: string }).v;
        if (this.eat("=")) this.parseExpr();
      } else if (p0.t === "name") { lhs = (this.next() as { v: string }).v; }
      const p1 = this.peek();
      if (p1.t === "name" && ((p1 as {v:string}).v === "in" || (p1 as {v:string}).v === "of")) {
        this.next();
        const obj = this.parseExpr(); this.expect(")");
        return { k: "forIn", lhs, obj, body: this.parseStmt() };
      }
    } catch { /* fall through */ }
    this.pos = save;
    let init: AstNode | null = null;
    if (!(this.peek().t === "punct" && (this.peek() as {v:string}).v === ";")) {
      const p0 = this.peek();
      if (p0.t === "name" && ["let", "var", "const"].includes((p0 as {v:string}).v)) init = this.parseVarNoSemi();
      else init = { k: "expr", expr: this.parseExpr() };
    }
    this.expect(";");
    let test: AstNode | null = null;
    if (!(this.peek().t === "punct" && (this.peek() as {v:string}).v === ";")) test = this.parseExpr();
    this.expect(";");
    let upd: AstNode | null = null;
    if (!(this.peek().t === "punct" && (this.peek() as {v:string}).v === ")")) upd = this.parseExpr();
    this.expect(")");
    return { k: "for", init, test, update: upd, body: this.parseStmt() };
  }
  parseVarNoSemi(): AstNode {
    const mode = (this.next() as { v: string }).v;
    const decls: { name: string; init: AstNode | null }[] = [];
    do {
      const n = this.next();
      decls.push({ name: (n as { v: string }).v, init: this.eat("=") ? this.parseExpr() : null });
    } while (this.eat(","));
    return { k: "var", mode, decls };
  }
  parseTry(): AstNode {
    this.next();
    const body = this.parseBlock();
    let cn: string | null = null, cb: AstNode | null = null, fb: AstNode | null = null;
    if (this.eatName("catch")) {
      this.expect("(");
      const n = this.next();
      cn = (n as { v: string }).v;
      this.expect(")");
      cb = this.parseBlock();
    }
    if (this.eatName("finally")) fb = this.parseBlock();
    return { k: "try", body, catchName: cn, catchBody: cb, finallyBody: fb };
  }

  // ---- expressions (precedence climbing) ----
  parseExpr(): AstNode { return this.parseSeq(); }
  parseSeq(): AstNode {
    const items = [this.parseAssign()];
    while (this.eat(",")) items.push(this.parseAssign());
    return items.length === 1 ? items[0] : { k: "seq", items };
  }
  parseAssign(): AstNode {
    const left = this.parseTernary();
    const t = this.peek();
    if (t.t === "punct" && ["=", "+=", "-=", "*=", "/=", "%=", "**=", "&&=", "||=", "??="].includes((t as {v:string}).v)) {
      const op = ((this.next() as unknown) as { v: string }).v;
      return { k: "assign", op, left, right: this.parseAssign() };
    }
    return left;
  }
  parseTernary(): AstNode {
    const t = this.parseNullish();
    if (this.eat("?")) {
      const y = this.parseExpr(); this.expect(":"); const n = this.parseExpr();
      return { k: "ternary", test: t, yes: y, no: n };
    }
    return t;
  }
  parseNullish(): AstNode {
    let l = this.parseOr();
    while (this.eat("??")) l = { k: "binary", op: "??", left: l, right: this.parseOr() };
    return l;
  }
  parseOr(): AstNode {
    let l = this.parseAnd();
    while (this.eat("||")) l = { k: "binary", op: "||", left: l, right: this.parseAnd() };
    return l;
  }
  parseAnd(): AstNode {
    let l = this.parseEq();
    while (this.eat("&&")) l = { k: "binary", op: "&&", left: l, right: this.parseEq() };
    return l;
  }
  parseEq(): AstNode {
    let l = this.parseCmp();
    for (;;) {
      const t = this.peek();
      if (t.t === "punct" && ["==", "!=", "===", "!=="].includes((t as {v:string}).v)) {
        const op = ((this.next() as unknown) as { v: string }).v;
        l = { k: "binary", op, left: l, right: this.parseCmp() };
      } else break;
    }
    return l;
  }
  parseCmp(): AstNode {
    let l = this.parseAdd();
    for (;;) {
      const t = this.peek();
      if (t.t === "punct" && ["<", ">", "<=", ">=", "in", "instanceof"].includes((t as {v:string}).v) ||
        (t.t === "name" && ((t as {v:string}).v === "in" || (t as {v:string}).v === "instanceof"))) {
        const op = ((this.next() as unknown) as { v: string }).v;
        l = { k: "binary", op, left: l, right: this.parseAdd() };
      } else break;
    }
    return l;
  }
  parseAdd(): AstNode {
    let l = this.parseMul();
    for (;;) {
      if (this.eat("+")) l = { k: "binary", op: "+", left: l, right: this.parseMul() };
      else if (this.eat("-")) l = { k: "binary", op: "-", left: l, right: this.parseMul() };
      else break;
    }
    return l;
  }
  parseMul(): AstNode {
    let l = this.parsePow();
    for (;;) {
      if (this.eat("*")) l = { k: "binary", op: "*", left: l, right: this.parsePow() };
      else if (this.eat("/")) l = { k: "binary", op: "/", left: l, right: this.parsePow() };
      else if (this.eat("%")) l = { k: "binary", op: "%", left: l, right: this.parsePow() };
      else break;
    }
    return l;
  }
  parsePow(): AstNode {
    const b = this.parseUnary();
    if (this.eat("**")) return { k: "binary", op: "**", left: b, right: this.parsePow() };
    return b;
  }
  parseUnary(): AstNode {
    if (this.eat("!")) return { k: "unary", op: "!", arg: this.parseUnary() };
    if (this.eat("-")) return { k: "unary", op: "-", arg: this.parseUnary() };
    if (this.eat("+")) return { k: "unary", op: "+", arg: this.parseUnary() };
    if (this.eat("~")) return { k: "unary", op: "~", arg: this.parseUnary() };
    const t = this.peek();
    if (t.t === "name" && (t as {v:string}).v === "typeof") { this.next(); return { k: "unary", op: "typeof", arg: this.parseUnary() }; }
    if (t.t === "name" && (t as {v:string}).v === "void") { this.next(); return { k: "unary", op: "void", arg: this.parseUnary() }; }
    if (t.t === "name" && (t as {v:string}).v === "delete") { this.next(); return { k: "unary", op: "delete", arg: this.parseUnary() }; }
    if (t.t === "punct" && ((t as {v:string}).v === "++" || (t as {v:string}).v === "--")) {
      const op = ((this.next() as unknown) as { v: string }).v;
      return { k: "unary", op, arg: this.parseUnary() };
    }
    return this.parsePostfix();
  }
  parsePostfix(): AstNode {
    let e = this.parsePrimary();
    for (;;) {
      if (this.eat("?.") || this.eat(".")) {
        const p = this.next();
        e = { k: "member", obj: e, prop: (p as { v: string }).v, computed: false, optional: false };
      } else if (this.eat("[")) {
        const idx = this.parseExpr(); this.expect("]");
        // fold to member with computed prop via special node
        e = { k: "member", obj: e, prop: "\u0000EXPR", computed: true, optional: false, ...( { expr: idx } as object) } as AstNode;
      } else if (this.eat("(")) {
        const args: AstNode[] = [];
        if (!this.eat(")")) {
          do { if (this.eat("...")) args.push(this.parseAssign()); else args.push(this.parseAssign()); } while (this.eat(","));
          this.expect(")");
        }
        e = { k: "call", callee: e, args };
      } else if (this.peek().t === "punct" && ["++", "--"].includes(((this.peek() as unknown) as { v: string }).v)) {
        const op = ((this.next() as unknown) as { v: string }).v;
        e = { k: "unary", op: op + "_post", arg: e };
      } else if (this.peek().t === "punct" && (this.peek() as {v:string}).v === "=>") {
        // arrow with single ident param
        this.next();
        const body = this.peek().t === "punct" && (this.peek() as {v:string}).v === "{" ? this.parseBlock() : this.parseAssign();
        const pname = e.k === "id" ? (e as { name: string }).name : "_";
        e = { k: "arrow", params: [pname], body };
      } else break;
    }
    return e;
  }
  parsePrimary(): AstNode {
    const t = this.next();
    if (t.t === "num") return { k: "lit", value: (t as { v: number }).v };
    if (t.t === "str") {
      const v = (t as { v: string }).v;
      if (v.startsWith("\u0000TPL:")) {
        const raw = v.slice(5);
        const parts: (string | AstNode)[] = [];
        let i = 0, cur = "";
        while (i < raw.length) {
          if (raw[i] === "$" && raw[i + 1] === "{") {
            parts.push(cur); cur = "";
            let d = 1, j = i + 2;
            while (j < raw.length && d > 0) { if (raw[j] === "{") d++; if (raw[j] === "}") d--; j++; }
            const inner = raw.slice(i + 2, j - 1);
            parts.push(new Parser(inner).parseExpr());
            i = j; continue;
          }
          cur += raw[i]; i++;
        }
        parts.push(cur);
        return { k: "tpl", parts };
      }
      return { k: "lit", value: v };
    }
    if (t.t === "name") {
      const v = (t as { v: string }).v;
      if (v === "true") return { k: "lit", value: true };
      if (v === "false") return { k: "lit", value: false };
      if (v === "null") return { k: "lit", value: null };
      if (v === "undefined") return { k: "lit", value: undefined };
      if (v === "this") return { k: "id", name: "this" };
      if (v === "function") {
        // anonymous function expression
        let name: string | null = null;
        if (this.peek().t === "name") name = ((this.next() as unknown) as { v: string }).v;
        this.expect("(");
        const params: string[] = [];
        while (!this.eat(")")) {
          const p = this.next(); params.push(((p as unknown) as { v: string }).v);
          if (!this.eat(",")) { this.expect(")"); break; }
        }
        return { k: "func", name, params, body: this.parseBlock(), expr: true };
      }
      if (v === "class") { this.pos--; return this.parseClass(); }
      if (v === "new") {
        // parse callee as member-only (no calls) so `new A(21).get()` works:
        // parseUnary would greedily consume `(21)` as a call — avoid that.
        let callee: AstNode = this.parsePrimary();
        for (;;) {
          if (this.eat(".") || this.eat("?.")) {
            const p = this.next();
            callee = { k: "member", obj: callee, prop: (p as unknown as { v: string }).v, computed: false, optional: false };
          } else if (this.eat("[")) {
            const idx = this.parseExpr(); this.expect("]");
            callee = { k: "member", obj: callee, prop: " EXPR", computed: true, optional: false, ...( { expr: idx } as object) } as AstNode;
          } else break;
        }
        let args: AstNode[] = [];
        if (this.eat("(")) {
          if (!this.eat(")")) { do { args.push(this.parseAssign()); } while (this.eat(",")); this.expect(")"); }
        }
        return { k: "new", callee, args };
      }
      // arrow with parens? check ahead: (a,b) => ...
      if (v === "(") { /* unreachable */ }
      return { k: "id", name: v };
    }
    if (t.t === "punct") {
      const v = (t as { v: string }).v;
      if (v === "(") {
        // could be arrow params
        const save = this.pos;
        try {
          const params: string[] = [];
          if (this.eat(")")) {
            if (this.eat("=>")) {
              const body = this.peek().t === "punct" && ((this.peek() as unknown) as { v: string }).v === "{" ? this.parseBlock() : this.parseAssign();
              return { k: "arrow", params, body };
            }
          } else {
            // try parse as params list of names
            const tmp: string[] = [];
            let okAllNames = true;
            while (true) {
              const nt = this.next();
              if (nt.t !== "name") { okAllNames = false; break; }
              tmp.push(((nt as unknown) as { v: string }).v);
              if (this.eat(",")) continue;
              if (this.eat(")")) break;
              okAllNames = false; break;
            }
            if (okAllNames && this.eat("=>")) {
              const body = this.peek().t === "punct" && ((this.peek() as unknown) as { v: string }).v === "{" ? this.parseBlock() : this.parseAssign();
              return { k: "arrow", params: tmp, body };
            }
          }
        } catch { /* fallthrough */ }
        this.pos = save;
        const e = this.parseExpr();
        this.expect(")");
        // arrow after parens-expr? handle single
        if (this.eat("=>")) {
          const body = this.peek().t === "punct" && ((this.peek() as unknown) as { v: string }).v === "{" ? this.parseBlock() : this.parseAssign();
          void e; void params;
          function params(): void { throw new Error("unreachable"); }
          return { k: "arrow", params: [], body };
        }
        return e;
      }
      if (v === "[") {
        const items: AstNode[] = [];
        if (!this.eat("]")) { do { items.push(this.parseAssign()); } while (this.eat(",")); this.expect("]"); }
        return { k: "arr", items };
      }
      if (v === "{") {
        const props: { key: string; value: AstNode }[] = [];
        if (!this.eat("}")) {
          do {
            const kt = this.next();
            const key = kt.t === "str" ? ((kt as unknown) as { v: string }).v : ((kt as unknown) as { v: string }).v;
            if (this.eat(":")) props.push({ key, value: this.parseAssign() });
            else props.push({ key, value: { k: "id", name: key } });
          } while (this.eat(","));
          this.expect("}");
        }
        return { k: "obj", props };
      }
    }
    throw new SyntaxError(`Unexpected token ${JSON.stringify(t)}`);
  }
}

// ---------------- Runtime ----------------
export class ReturnSignal { constructor(public value: unknown) {} }
export class BreakSignal {}
export class ContinueSignal {}
export class ThrowSignal { constructor(public value: unknown) {} }

export type HostHooks = {
  setTimeout: (fn: (...a: never[]) => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  setInterval: (fn: (...a: never[]) => void, ms: number) => number;
  clearInterval: (id: number) => void;
  queueMicrotask: (fn: () => void) => void;
  fetch: (url: string, opts?: unknown) => Promise<unknown>;
  consoleLog: (...a: unknown[]) => void;
};

export class Env {
  store = new Map<string, unknown>();
  consts = new Set<string>();
  constructor(public parent: Env | null = null) {}
  declare(name: string, v: unknown, isConst = false): void {
    this.store.set(name, v);
    if (isConst) this.consts.add(name);
  }
  assign(name: string, v: unknown): boolean {
    if (this.store.has(name)) {
      if (this.consts.has(name)) throw new TypeError(`Assignment to constant ${name}`);
      this.store.set(name, v); return true;
    }
    if (this.parent) return this.parent.assign(name, v);
    return false;
  }
  lookup(name: string): unknown {
    if (this.store.has(name)) return this.store.get(name);
    if (this.parent) return this.parent.lookup(name);
    throw new ReferenceError(`${name} is not defined`);
  }
}

export class JSFunction {
  constructor(
    public params: string[],
    public body: AstNode,
    public closure: Env,
    public interp: Interpreter,
    public name = "anonymous",
    public isArrow = false,
  ) {}
  call(thisArg: unknown, args: unknown[]): unknown {
    const env = new Env(this.isArrow ? this.closure : new Env(this.closure));
    if (!this.isArrow) env.declare("this", thisArg);
    else { try { env.declare("this", this.closure.lookup("this")); } catch { env.declare("this", undefined); } }
    env.declare("arguments", args);
    this.params.forEach((p, i) => env.declare(p, args[i]));
    try {
      // expression-bodied arrow (e.g. () => x+1): eval and return the value
      if (this.body.k !== "block" && this.body.k !== "program") {
        return this.interp.eval(this.body, new Env(env));
      }
      this.interp.execBlock(this.body, env);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return undefined;
  }
}

function toDisplay(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

export class Interpreter {
  global: Env;
  hooks: HostHooks;
  constructor(hooks: HostHooks) {
    this.hooks = hooks;
    this.global = new Env(null);
    this.installBuiltins();
  }

  installBuiltins(): void {
    const g = this.global;
    g.declare("console", {
      log: (...a: unknown[]) => this.hooks.consoleLog(...a.map(x => (typeof x === "object" ? x : toDisplay(x)))),
      error: (...a: unknown[]) => this.hooks.consoleLog("[error]", ...a),
      warn: (...a: unknown[]) => this.hooks.consoleLog("[warn]", ...a),
    });
    g.declare("Math", Object.create(null, {
      PI: { value: Math.PI }, E: { value: Math.E },
    }) as object);
    Object.assign(g.lookup("Math") as object, {
      floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs,
      max: Math.max, min: Math.min, random: Math.random, sqrt: Math.sqrt, pow: Math.pow,
      sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log, trunc: Math.trunc, sign: Math.sign,
    });
    g.declare("JSON", { parse: JSON.parse, stringify: JSON.stringify });
    g.declare("Object", Object.assign(function () {}, {
      keys: Object.keys, values: Object.values, entries: Object.entries, assign: Object.assign,
      freeze: (o: object) => o, is: Object.is,
    }));
    g.declare("Array", Object.assign(function () {}, { isArray: Array.isArray, from: Array.from }));
    g.declare("Number", Object.assign(function (v: unknown) { return Number(v); }, { isNaN: Number.isNaN, isFinite: Number.isFinite, parseInt, parseFloat }));
    g.declare("String", Object.assign(function (v: unknown) { return String(v); }, { fromCharCode: String.fromCharCode }));
    g.declare("Boolean", (v: unknown) => Boolean(v));
    g.declare("isNaN", isNaN); g.declare("parseInt", parseInt); g.declare("parseFloat", parseFloat);
    g.declare("setTimeout", (fn: unknown, ms: unknown) => {
      if (typeof fn === "function") return this.hooks.setTimeout(fn as (...a: never[]) => void, Number(ms) || 0);
      const code = String(fn);
      return this.hooks.setTimeout(() => this.run(code), Number(ms) || 0);
    });
    g.declare("clearTimeout", (id: unknown) => this.hooks.clearTimeout(Number(id)));
    g.declare("setInterval", (fn: unknown, ms: unknown) => {
      if (typeof fn === "function") return this.hooks.setInterval(fn as (...a: never[]) => void, Number(ms) || 0);
      const code = String(fn);
      return this.hooks.setInterval(() => this.run(code), Number(ms) || 0);
    });
    g.declare("clearInterval", (id: unknown) => this.hooks.clearInterval(Number(id)));
    g.declare("queueMicrotask", (fn: unknown) => this.hooks.queueMicrotask(fn as () => void));
    g.declare("fetch", (url: unknown) => this.hooks.fetch(String(url)));
    // Promise lite
    const interp = this;
    class JSPromise {
      then_: ((v: unknown) => unknown)[] = [];
      val: unknown; settled = false;
      constructor(exec: unknown) {
        if (typeof exec === "function") {
          try {
            (exec as (res: (v: unknown) => void, rej: (e: unknown) => void) => void)(
              (v) => this.resolve(v), (e) => this.resolve(e));
          } catch (e) { this.resolve(e); }
        }
      }
      resolve(v: unknown): void {
        if (this.settled) return;
        this.settled = true; this.val = v;
        for (const t of this.then_) interp.hooks.queueMicrotask(() => { try { t(v); } catch { } });
      }
      then(fn: unknown): JSPromise {
        const p = new JSPromise(() => {});
        const wrap = (v: unknown) => {
          try {
            const r = (fn as (x: unknown) => unknown)(v);
            if (r instanceof JSPromise) r.then((x: unknown) => p.resolve(x));
            else p.resolve(r);
          } catch (e) { p.resolve(e); }
        };
        if (this.settled) interp.hooks.queueMicrotask(() => wrap(this.val));
        else this.then_.push(wrap);
        return p;
      }
    }
    g.declare("Promise", Object.assign(function (this: unknown, exec: unknown) { return new JSPromise(exec); }, {
      resolve: (v: unknown) => { const p = new JSPromise(() => {}); p.resolve(v); return p; },
    }));
  }

  run(src: string, env?: Env): unknown {
    const ast = new Parser(src).parseProgram();
    return this.exec(ast, env ?? this.global);
  }

  exec(node: AstNode, env: Env): unknown {
    switch (node.k) {
      case "program": { let v: unknown; for (const s of node.body) v = this.exec(s, env); return v; }
      case "block": return this.execBlock(node, env);
      case "var": {
        for (const d of node.decls) {
          const v = d.init ? this.eval(d.init, env) : undefined;
          if (node.mode === "var" && env.parent) {
            // var hoists to function/global scope — simplify to current
          }
          env.declare(d.name, v, node.mode === "const");
        }
        return undefined;
      }
      case "func": {
        const fn = new JSFunction(node.params, node.body, env, this, node.name ?? "anonymous");
        if (node.name) env.declare(node.name, fn);
        return fn;
      }
      case "class": return this.execClass(node, env);
      case "return": throw new ReturnSignal(node.arg ? this.eval(node.arg, env) : undefined);
      case "if": {
        const t = this.truthy(this.eval(node.test, env));
        return t ? this.exec(node.yes, env) : node.no ? this.exec(node.no, env) : undefined;
      }
      case "while": {
        let last: unknown;
        for (;;) {
          if (!this.truthy(this.eval(node.test, env))) break;
          try { last = this.exec(node.body, new Env(env)); }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return last;
      }
      case "for": {
        const fenv = new Env(env);
        if (node.init) this.exec(node.init, fenv);
        let last: unknown;
        for (;;) {
          if (node.test && !this.truthy(this.eval(node.test, fenv))) break;
          try { last = this.exec(node.body, new Env(fenv)); }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) { /* update then continue */ } else throw e; }
          if (node.update) this.eval(node.update, fenv);
        }
        return last;
      }
      case "forIn": {
        const obj = this.eval(node.obj, env);
        const vals: unknown[] = Array.isArray(obj) ? obj : (obj && typeof obj === "object" ? Object.keys(obj as object) : []);
        let last: unknown;
        for (const key of (Array.isArray(obj) ? (obj as unknown[]).map((_, i) => i) : vals) as unknown[]) {
          const fenv = new Env(env);
          fenv.declare(node.lhs, key);
          try { last = this.exec(node.body, fenv); }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return last;
      }
      case "throw": throw new ThrowSignal(this.eval(node.arg, env));
      case "try": {
        try { return this.exec(node.body, new Env(env)); }
        catch (e) {
          const val = e instanceof ThrowSignal ? e.value : e;
          if (node.catchBody) {
            const cenv = new Env(env);
            if (node.catchName) cenv.declare(node.catchName, val);
            try { return this.exec(node.catchBody, cenv); }
            finally { if (node.finallyBody) this.exec(node.finallyBody, new Env(env)); }
          }
          if (node.finallyBody) this.exec(node.finallyBody, new Env(env));
          if (!node.catchBody) throw e;
          return undefined;
        }
      }
      case "expr": return this.eval(node.expr, env);
      case "break": throw new BreakSignal();
      case "continue": throw new ContinueSignal();
      case "debugger": return undefined;
    }
  }

  execBlock(node: AstNode, env: Env): unknown {
    if (node.k !== "block" && node.k !== "program") return this.exec(node, env);
    let v: unknown;
    const benv = new Env(env);
    for (const s of (node as { body: AstNode[] }).body) v = this.exec(s, benv);
    return v;
  }

  execClass(node: Extract<AstNode, { k: "class" }>, env: Env): unknown {
    const interp = this;
    const Super = node.super ? this.eval(node.super, env) : null;
    class Made {
      static __isClass = true;
      constructor(...args: unknown[]) {
        const self = this as unknown as Record<string, unknown>;
        for (const f of node.fields) self[f.name] = f.init ? interp.eval(f.init, env) : undefined;
        const ctor = node.methods.find(m => m.name === "constructor");
        if (ctor) {
          const fn = new JSFunction(
            (ctor.fn as Extract<AstNode, { k: "func" }>).params,
            (ctor.fn as Extract<AstNode, { k: "func" }>).body, env, interp, "constructor");
          fn.call(this, args);
        }
      }
    }
    for (const m of node.methods) {
      if (m.name === "constructor") continue;
      const fn = new JSFunction(
        (m.fn as Extract<AstNode, { k: "func" }>).params,
        (m.fn as Extract<AstNode, { k: "func" }>).body, env, interp, m.name);
      if (m.static) (Made as unknown as Record<string, unknown>)[m.name] = (...a: unknown[]) => fn.call(Made, a);
      else (Made.prototype as unknown as Record<string, unknown>)[m.name] = function (this: unknown, ...a: unknown[]) { return fn.call(this, a); };
    }
    if (Super && typeof Super === "function") Object.setPrototypeOf(Made.prototype, (Super as unknown as { prototype: object }).prototype);
    if (node.name) env.declare(node.name, Made);
    return Made;
  }

  truthy(v: unknown): boolean {
    if (!v) return false;
    if (v === 0 || v === "" || Number.isNaN(v)) return false;
    return true;
  }

  eval(node: AstNode, env: Env): unknown {
    switch (node.k) {
      case "lit": return node.value;
      case "tpl": return node.parts.map(p => typeof p === "string" ? p : toDisplay(this.eval(p, env))).join("");
      case "id": {
        if ((node as { name: string }).name === "this") { try { return env.lookup("this"); } catch { return undefined; } }
        // globalThis fallback
        try { return env.lookup((node as { name: string }).name); }
        catch { throw new ReferenceError(`${(node as { name: string }).name} is not defined`); }
      }
      case "arr": return node.items.map(i => this.eval(i, env));
      case "obj": {
        const o: Record<string, unknown> = {};
        for (const p of node.props) o[p.key] = this.eval(p.value, env);
        return o;
      }
      case "func": return new JSFunction(node.params, node.body, env, this, node.name ?? "anonymous");
      case "arrow": return new JSFunction(node.params, node.body, env, this, "arrow", true);
      case "unary": return this.evalUnary(node.op, node.arg, env);
      case "binary": return this.evalBinary(node.op, node.left, node.right, env);
      case "assign": return this.evalAssign(node.op, node.left, node.right, env);
      case "ternary": return this.truthy(this.eval(node.test, env)) ? this.eval(node.yes, env) : this.eval(node.no, env);
      case "seq": { let v: unknown; for (const i of node.items) v = this.eval(i, env); return v; }
      case "member": return this.evalMember(node, env).get();
      case "call": {
        const { fn, thisArg } = this.resolveCall(node.callee, env);
        const args = node.args.map(a => this.eval(a, env));
        if (fn instanceof JSFunction) return fn.call(thisArg, args);
        if (typeof fn === "function") return (fn as (...a: unknown[]) => unknown).apply(thisArg, args);
        throw new TypeError("Callee is not a function");
      }
      case "new": {
        const Ctor = this.eval(node.callee, env) as unknown;
        const args = node.args.map(a => this.eval(a, env));
        if (Ctor instanceof JSFunction) {
          const o = Object.create(null);
          const r = Ctor.call(o, args);
          return (r && typeof r === "object") ? r : o;
        }
        if (typeof Ctor === "function") return new (Ctor as new (...a: unknown[]) => unknown)(...args);
        throw new TypeError("Constructor is not a constructor");
      }
      default: return this.exec(node, env);
    }
  }

  evalUnary(op: string, arg: AstNode, env: Env): unknown {
    if (op === "++" || op === "--" || op === "++_post" || op === "--_post") {
      const ref = this.evalRef(arg, env);
      const cur = Number(ref.get()) || 0;
      const next = op.startsWith("++") ? cur + 1 : cur - 1;
      ref.set(next);
      return op.endsWith("_post") ? cur : next;
    }
    if (op === "delete") {
      if (arg.k === "member") {
        const m = this.evalMember(arg as Extract<AstNode, { k: "member" }>, env);
        return m.del();
      }
      return true;
    }
    const v = this.eval(arg, env);
    switch (op) {
      case "!": return !this.truthy(v);
      case "-": return -(Number(v) || 0);
      case "+": return Number(v);
      case "~": return ~(Number(v) || 0);
      case "typeof": {
        if (v instanceof JSFunction) return "function";
        if (v === null) return "object";
        return typeof v;
      }
      case "void": return undefined;
      default: return undefined;
    }
  }

  evalBinary(op: string, l: AstNode, r: AstNode, env: Env): unknown {
    if (op === "&&") { const lv = this.eval(l, env); return this.truthy(lv) ? this.eval(r, env) : lv; }
    if (op === "||") { const lv = this.eval(l, env); return this.truthy(lv) ? lv : this.eval(r, env); }
    if (op === "??") { const lv = this.eval(l, env); return lv === null || lv === undefined ? this.eval(r, env) : lv; }
    const lv = this.eval(l, env), rv = this.eval(r, env);
    switch (op) {
      case "+": {
        if (typeof lv === "string" || typeof rv === "string") return toDisplay(lv) + toDisplay(rv);
        return (Number(lv) || 0) + (Number(rv) || 0);
      }
      case "-": return (Number(lv) || 0) - (Number(rv) || 0);
      case "*": return (Number(lv) || 0) * (Number(rv) || 0);
      case "/": return (Number(lv) || 0) / (Number(rv) || 0);
      case "%": return (Number(lv) || 0) % (Number(rv) || 0);
      case "**": return ((Number(lv) || 0) ** (Number(rv) || 0));
      case "==": return lv == rv;
      case "!=": return lv != rv;
      case "===": return lv === rv;
      case "!==": return lv !== rv;
      case "<": return (lv as number) < (rv as number);
      case ">": return (lv as number) > (rv as number);
      case "<=": return (lv as number) <= (rv as number);
      case ">=": return (lv as number) >= (rv as number);
      case "in": {
        if (rv && typeof rv === "object") return String(lv) in (rv as object);
        return false;
      }
      case "instanceof": {
        if (typeof rv === "function" && lv && typeof lv === "object") {
          let p = Object.getPrototypeOf(lv);
          while (p) { if (p === (rv as { prototype: object }).prototype) return true; p = Object.getPrototypeOf(p); }
        }
        return false;
      }
      default: return undefined;
    }
  }

  evalRef(target: AstNode, env: Env): { get: () => unknown; set: (v: unknown) => void } {
    if (target.k === "id") {
      const name = (target as { name: string }).name;
      return {
        get: () => env.lookup(name),
        set: (v) => { if (!env.assign(name, v)) env.declare(name, v); },
      };
    }
    if (target.k === "member") return this.evalMember(target as Extract<AstNode, { k: "member" }>, env);
    throw new ReferenceError("Invalid assignment target");
  }

  evalMember(node: Extract<AstNode, { k: "member" }>, env: Env): { get: () => unknown; set: (v: unknown) => void; del: () => boolean } {
    const obj = this.eval(node.obj, env);
    let prop: string;
    const extra = (node as unknown as { expr?: AstNode }).expr;
    if (extra) prop = String(this.eval(extra, env));
    else prop = node.prop;
    const get = (): unknown => {
      if (obj === null || obj === undefined) throw new TypeError(`Cannot read '${prop}' of ${obj}`);
      // array length etc. work natively
      const v = (obj as Record<string, unknown>)[prop];
      if (typeof v === "function" && obj && typeof obj === "object" && !(obj instanceof JSFunction)) {
        // bind host methods
        return (v as (...a: unknown[]) => unknown).bind(obj);
      }
      return v;
    };
    return {
      get,
      set: (v) => { if (obj !== null && typeof obj === "object") (obj as Record<string, unknown>)[prop] = v; },
      del: () => { if (obj && typeof obj === "object") { delete (obj as Record<string, unknown>)[prop]; return true; } return false; },
    };
  }

  resolveCall(callee: AstNode, env: Env): { fn: unknown; thisArg: unknown } {
    if (callee.k === "member") {
      const m = callee as Extract<AstNode, { k: "member" }>;
      const extra = (m as unknown as { expr?: AstNode }).expr;
      const obj = this.eval(m.obj, env);
      const prop = extra ? String(this.eval(extra, env)) : m.prop;
      if (obj === null || obj === undefined) throw new TypeError("Cannot call of null");
      const fn = (obj as Record<string, unknown>)[prop];
      return { fn, thisArg: obj };
    }
    return { fn: this.eval(callee, env), thisArg: undefined };
  }

  evalAssign(op: string, left: AstNode, right: AstNode, env: Env): unknown {
    const ref = this.evalRef(left, env);
    const rv = this.eval(right, env);
    if (op === "=") { ref.set(rv); return rv; }
    const lv = ref.get() as number;
    let out: unknown = rv;
    if (op === "+=") out = typeof lv === "string" ? String(lv) + toDisplay(rv) : (Number(lv) || 0) + (Number(rv) || 0);
    else if (op === "-=") out = (Number(lv) || 0) - (Number(rv) || 0);
    else if (op === "*=") out = (Number(lv) || 0) * (Number(rv) || 0);
    else if (op === "/=") out = (Number(lv) || 0) / (Number(rv) || 0);
    else if (op === "%=") out = (Number(lv) || 0) % (Number(rv) || 0);
    ref.set(out);
    return out;
  }
}

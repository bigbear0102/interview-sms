// POP3 로 그룹웨어 메일함을 읽는다(웹 로그인은 그룹웨어가 서버 접속을 처리하지 못해 500 이 나서, 2026-10-17 사용자 승인).
// - 그룹웨어 메일 서버는 POP3(110) 암호화(STLS)를 지원하지 않는다 → 비밀번호가 암호화 없이 오간다(사용자가 위험을 감수하고 승인).
// - 메일을 지우지 않는다(DELE 없음). UIDL 로 새 메일만 골라 머리(TOP)로 알바몬 발신만 걸러 본문(RETR)을 받는다.
// - Workers 에서는 cloudflare:sockets, Node(회사 서버·시험)에서는 node:net 으로 연결한다.

const enc = new TextEncoder();

// { readable, writable, close } 를 돌려준다
export async function openTcp(hostname, port) {
  if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') {
    const { connect } = await import('cloudflare:sockets');
    const s = connect({ hostname, port });
    return { readable: s.readable, writable: s.writable, close: () => s.close() };
  }
  const net = await import('node:net');
  const { Duplex } = await import('node:stream');
  const sock = net.connect({ host: hostname, port });
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  const d = Duplex.toWeb(sock);
  return { readable: d.readable, writable: d.writable, close: () => sock.destroy() };
}

// 줄 단위 읽기(바이트 그대로)
class Lines {
  constructor(readable) { this.reader = readable.getReader(); this.buf = new Uint8Array(0); }
  async more() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error('POP3 연결이 끊겼어요');
    const b = new Uint8Array(this.buf.length + value.length);
    b.set(this.buf); b.set(value, this.buf.length); this.buf = b;
  }
  async line() {   // \r\n 을 뺀 한 줄(Uint8Array)
    for (;;) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const out = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2); return out;
        }
      }
      await this.more();
    }
  }
}
const text = (u8) => new TextDecoder('latin1').decode(u8);

export class Pop3 {
  constructor(conn, { timeoutMs = 20000 } = {}) {
    this.conn = conn; this.lines = new Lines(conn.readable); this.w = conn.writable.getWriter(); this.timeoutMs = timeoutMs;
  }
  withTimeout(p) {   // 응답이 오면 타이머를 지운다(남은 타이머가 실행을 붙잡지 않게)
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('POP3 응답 시간 초과')), this.timeoutMs); })]).finally(() => clearTimeout(t));
  }
  async status() { const l = text(await this.withTimeout(this.lines.line())); return { ok: l.startsWith('+OK'), line: l }; }
  async cmd(c) { await this.w.write(enc.encode(c + '\r\n')); return this.status(); }
  // 여러 줄 응답(끝은 "."), 점으로 시작하는 줄은 하나를 뺀다. 반환: 줄 배열(Uint8Array)
  async multi() {
    const out = [];
    for (;;) {
      const l = await this.withTimeout(this.lines.line());
      if (l.length === 1 && l[0] === 46) return out;
      out.push(l[0] === 46 ? l.slice(1) : l);
    }
  }
  async greet() { return this.status(); }
  async login(user, pass) {
    const u = await this.cmd('USER ' + user);
    if (!u.ok) return u;
    return this.cmd('PASS ' + pass);
  }
  async uidl() {   // [{ n, uid }]
    const s = await this.cmd('UIDL');
    if (!s.ok) throw new Error('UIDL 실패: ' + s.line.slice(0, 80));
    return (await this.multi()).map((l) => text(l).trim().split(/\s+/)).filter((p) => p.length >= 2).map(([n, uid]) => ({ n: Number(n), uid }));
  }
  async top(n, lines = 0) {   // 머리 글(문자열)
    const s = await this.cmd(`TOP ${n} ${lines}`);
    if (!s.ok) return '';
    return (await this.multi()).map(text).join('\n');
  }
  async retr(n) {   // 원문 바이트
    const s = await this.cmd(`RETR ${n}`);
    if (!s.ok) return null;
    const parts = await this.multi();
    const len = parts.reduce((a, p) => a + p.length + 2, 0);
    const out = new Uint8Array(len); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 13; out[o++] = 10; }
    return out;
  }
  async quit() { try { await this.cmd('QUIT'); } catch { /* 이미 끊김 */ } try { this.conn.close(); } catch { /* ignore */ } }
}

// 머리 글에서 보낸 사람이 알바몬인지
export const fromAlbamon = (headers) => /^from:.*albamon\.com/im.test(String(headers).replace(/\r?\n[ \t]+/g, ' '));

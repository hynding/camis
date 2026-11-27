// A client streaming a 50 MB body to a refusing endpoint, run by endpoint-guards.test.ts in a
// process of its own, as a real client is: only then can the server's reset reach it while the
// answer is still unread. It reads as it sends, and prints one line a run: the answer's status
// line, or what ended the connection.
//
//   node streaming-client.mjs <port> declared|chunked <runs>
import { Buffer } from "node:buffer";
import { connect } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";

const [port, mode, runs] = process.argv.slice(2);
const chunked = mode === "chunked";
const BODY = 50 * 1024 * 1024;
const piece = Buffer.alloc(64 * 1024, 120);
const framed = chunked
  ? Buffer.concat([Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from("\r\n")])
  : piece;
const head = [
  "POST /api/articles/7/ingest HTTP/1.1",
  "Host: localhost",
  "Content-Type: application/json",
  chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${BODY}`,
  "",
  "",
].join("\r\n");

const once = () =>
  new Promise((resolve) => {
    const socket = connect(Number(port), "127.0.0.1");
    let received = "";
    let sent = 0;
    let open = true;
    let failed = "";
    const pump = () => {
      while (open && sent < BODY) {
        sent += piece.length;
        if (!socket.write(framed)) {
          socket.once("drain", pump);
          return;
        }
      }
      if (open) socket.end(chunked ? "0\r\n\r\n" : "");
    };
    socket.on("data", (data) => (received += data.toString("latin1")));
    // The server has answered and shut its side: stop sending, as curl does.
    socket.on("end", () => socket.destroy());
    socket.on("error", (error) => (failed = error.code ?? "error"));
    const timer = setTimeout(() => socket.destroy(), 20_000);
    socket.on("close", () => {
      open = false;
      clearTimeout(timer);
      resolve(received.split("\r\n")[0] || failed || "nothing");
    });
    socket.on("connect", () => {
      socket.write(head);
      pump();
    });
  });

for (let run = 0; run < Number(runs); run += 1) console.log(await once());

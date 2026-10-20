const { fetch: upstreamFetch } = require("undici");
const url = process.argv[2];
if (!url) throw new Error("Expected a local HTTP fixture URL.");

(async () => {
  const response = await upstreamFetch(url);
  if (response.status !== 200) {
    throw new Error(`Expected HTTP 200, received ${response.status}.`);
  }
  // Let the socket FIN reach Undici while its response body is still unread.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== 64 * 1024) {
    throw new Error(`Expected 65536 response bytes, received ${body.length}.`);
  }
  console.log(`response body remained intact through socket EOF (${body.length} bytes)`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { bm25Search } from '../server/memory-module-retrieval.js';

const documentCount = Math.max(1, Number(process.env.MEMORY_BENCHMARK_DOCUMENTS || 10_000));
const requestCount = Math.max(1, Number(process.env.MEMORY_BENCHMARK_REQUESTS || 20));
const concurrency = Math.max(1, Math.min(requestCount, Number(process.env.MEMORY_BENCHMARK_CONCURRENCY || 20)));
const limit = Math.max(1, Number(process.env.MEMORY_BENCHMARK_LIMIT || 20));
const documents = Array.from({ length: documentCount }, (_, index) => ({
  id: `benchmark-${index}`,
  text: `tenant-${index % 17} user-${index % 101} synthetic memory topic-${index % 37} ${index % 11 === 0 ? '红茶 release recovery' : 'ordinary context'}`
}));
const queries = ['红茶', 'release recovery', 'ordinary context', 'topic-17'];
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/retrieve') {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  try {
    const payload = JSON.parse(body);
    bm25Search(documents, payload.query, { limit });
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' }).end('{"ok":false}');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
const endpoint = `http://127.0.0.1:${address.port}/retrieve`;
const durations = [];
try {
  for (let completed = 0; completed < requestCount; completed += concurrency) {
    const batchSize = Math.min(concurrency, requestCount - completed);
    const batch = await Promise.all(Array.from({ length: batchSize }, (_, offset) => (async () => {
      const started = performance.now();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: queries[(completed + offset) % queries.length] })
      });
      if (!response.ok) throw new Error(`benchmark request failed: ${response.status}`);
      await response.text();
      return performance.now() - started;
    })()));
    durations.push(...batch);
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
durations.sort((a, b) => a - b);
const percentile = ratio => durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * ratio))];
console.log(JSON.stringify({
  event: 'memory_module_benchmark',
  mode: 'synthetic_bm25_http_single_process',
  documentCount,
  requestCount,
  concurrency,
  limit,
  p50Ms: percentile(0.50),
  p95Ms: percentile(0.95),
  p99Ms: percentile(0.99),
  note: 'Concurrent local HTTP load over in-memory BM25 only; not a substitute for the roadmap PostgreSQL/pgvector 1M-document, 20-concurrent acceptance run.'
}));

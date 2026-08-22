import type { INestApplication } from '@nestjs/common';

/**
 * Bind the test app to one ephemeral port for the whole spec file.
 *
 * Every spec here used to stop at `app.init()`, leaving a server that never
 * listens. supertest handles that by binding a fresh ephemeral port for EVERY
 * request and closing it again afterwards:
 *
 *   serverAddress(app, path) {
 *     const addr = app.address();
 *     if (!addr) this._server = app.listen(0);   // supertest/lib/test.js
 *
 * A few hundred bind/close cycles per run is enough to occasionally lose a
 * request to a socket that is being torn down, which surfaces as a bare
 * `Error: socket hang up` on a request the server never even logged.
 *
 * Measured on this machine, sequential requests, no concurrency:
 *
 *            bind per request   listen once
 *   real app     7 / 30,000       0 / 30,000
 *   bare http   17 / 120,000      0 / 120,000
 *
 * At roughly 200 requests per suite run that is a failure every twenty-odd
 * runs — which is exactly the rate at which CI would have been failing on a
 * random test with an error message that names nothing.
 *
 * Listening once removes the cycle entirely: supertest only binds when
 * `address()` is null, so it reuses this server and never closes it. It is
 * also faster. `app.close()` in afterAll still tears the listener down.
 */
export async function listenOnce(app: INestApplication): Promise<void> {
  await app.listen(0, '127.0.0.1');
}

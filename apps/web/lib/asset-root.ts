import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the on-disk root of the /assets folder.
 *
 * `ASSETS_ROOT` env var wins when set (used in Docker, where the folder is
 * mounted at a known path). Otherwise we walk up from this file to the repo
 * root and pick /assets there. Either way, the running app reads files at
 * request time — never bundling them.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ASSETS = path.resolve(HERE, '..', '..', '..', 'assets');

export const ASSETS_ROOT: string = process.env.ASSETS_ROOT?.trim() || REPO_ASSETS;

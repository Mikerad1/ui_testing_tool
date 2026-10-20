import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { validateArchivePaths, validateTarTypes } from '../dist/src/cli/updater.js';

const [archivePath, expectedTop] = process.argv.slice(2);
if (!archivePath || !expectedTop) throw new Error('Usage: validate-release-archive.mjs <archive> <expected-root>');
const zip = process.platform === 'win32';
const listing = spawnSync('tar', zip ? ['-tf', archivePath] : ['-tzf', archivePath], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
if (listing.error || listing.status !== 0) throw new Error(`Cannot inspect final archive path list: ${listing.stderr || listing.error?.message || listing.status}`);
assert.equal(validateArchivePaths(listing.stdout, expectedTop), 'nested');
const details = spawnSync('tar', zip ? ['-tvf', archivePath] : ['-tvzf', archivePath], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
if (details.error || details.status !== 0) throw new Error(`Cannot inspect final archive entry types: ${details.stderr || details.error?.message || details.status}`);
validateTarTypes(details.stdout);
console.log(`Updater path/type validation passed for ${path.basename(archivePath)}.`);

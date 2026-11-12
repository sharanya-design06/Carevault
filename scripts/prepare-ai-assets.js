const { createReadStream } = require('node:fs');
const { copyFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { createGzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const root = path.resolve(__dirname, '..');
const pdfBuild = path.dirname(require.resolve('pdfjs-dist'));
const pdfPackage = path.dirname(pdfBuild);
const pdfTarget = path.join(root, 'public', 'assets', 'vendor', 'pdfjs');
const dataTarget = path.join(root, 'public', 'assets', 'data');

async function main() {
  await Promise.all([mkdir(pdfTarget, { recursive: true }), mkdir(dataTarget, { recursive: true })]);
  await Promise.all([
    copyFile(path.join(pdfBuild, 'pdf.min.mjs'), path.join(pdfTarget, 'pdf.min.mjs')),
    copyFile(path.join(pdfBuild, 'pdf.worker.min.mjs'), path.join(pdfTarget, 'pdf.worker.min.mjs')),
    copyFile(path.join(pdfPackage, 'LICENSE'), path.join(pdfTarget, 'LICENSE')),
  ]);
  await pipeline(
    createReadStream(path.join(root, 'db_drug_interactions.csv')),
    createGzip({ level: 9 }),
    require('node:fs').createWriteStream(path.join(dataTarget, 'drug-interactions.csv.gz'))
  );
  console.log('Prepared local PDF extraction and drug interaction data assets.');
}

main().catch((error) => {
  console.error('Could not prepare AI assets:', error);
  process.exitCode = 1;
});

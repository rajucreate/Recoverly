import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateRecoveryDataset, validateRecoveryDataset, writeRecoveryDatasetArtifacts } from './recovery-dataset-generator.js';

function parseArgs(argv) {
  const args = { seed: 42, rowCount: 6000 };

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];

    if (entry === '--seed') {
      args.seed = Number(argv[index + 1]);
      index += 1;
    } else if (entry === '--row-count') {
      args.rowCount = Number(argv[index + 1]);
      index += 1;
    } else if (entry === '--output-dir') {
      args.outputDir = argv[index + 1];
      index += 1;
    }
  }

  return args;
}

function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const argv = process.argv.slice(2);
  const options = parseArgs(argv);

  const rootDirectory = path.resolve(path.dirname(scriptPath), '../../..');
  const outputDirectory = options.outputDir ? path.resolve(options.outputDir) : path.join(rootDirectory, 'data', 'phase-2');

  const { rows, metadata } = generateRecoveryDataset({
    seed: options.seed,
    rowCount: options.rowCount
  });

  validateRecoveryDataset(rows);

  const { csvPath, metadataPath, datasetSha256 } = writeRecoveryDatasetArtifacts({
    rows,
    metadata,
    outputDirectory
  });

  console.log(`Generated dataset at ${csvPath}`);
  console.log(`Metadata at ${metadataPath}`);
  console.log(`Rows: ${rows.length}`);
  console.log(`Seed: ${options.seed}`);
  console.log(`SHA-256: ${datasetSha256}`);
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main();
}

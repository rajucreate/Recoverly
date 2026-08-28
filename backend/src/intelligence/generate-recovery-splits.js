import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAndSplitDataset } from './recovery-dataset-split.js';

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const rootDirectory = path.resolve(scriptDirectory, '../../..');
  const dataDirectory = path.join(rootDirectory, 'data', 'phase-2');
  const result = loadAndSplitDataset(
    path.join(dataDirectory, 'recovery_dataset_v1.csv'),
    path.join(dataDirectory, 'recovery_features_v1.csv'),
    path.join(dataDirectory, 'splits'),
    JSON.parse(fs.readFileSync(path.join(dataDirectory, 'recovery_dataset_v1.metadata.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(dataDirectory, 'recovery_features_v1.metadata.json'), 'utf8'))
  );

  console.log(`Generated chronological splits in ${path.join(dataDirectory, 'splits')}`);
  for (const [name, split] of Object.entries(result.splits)) console.log(`${name}: ${split.rows.length} rows`);
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) main();

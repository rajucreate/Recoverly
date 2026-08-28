import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAndTransformDataset } from './recovery-feature-pipeline.js';

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const rootDirectory = path.resolve(scriptDirectory, '../../..');
  const inputPath = path.join(rootDirectory, 'data', 'phase-2', 'recovery_dataset_v1.csv');
  const outputDirectory = path.join(rootDirectory, 'data', 'phase-2');
  const schemaPath = path.join(outputDirectory, 'recovery_features_v1.schema.json');
  const artifacts = loadAndTransformDataset(inputPath, outputDirectory, schemaPath);

  console.log(`Generated feature matrix at ${artifacts.featurePath}`);
  console.log(`Feature schema at ${artifacts.schemaPath}`);
  console.log(`Rows: ${artifacts.rows.length}`);
  console.log(`Features: ${artifacts.schema.feature_columns.length}`);
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) main();

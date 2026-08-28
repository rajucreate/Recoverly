import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCsv, renderQualityReport, validateQuality } from './recovery-dataset-quality.js';

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const rootDirectory = path.resolve(scriptDirectory, '../../..');
  const datasetPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(rootDirectory, 'data', 'phase-2', 'recovery_dataset_v1.csv');
  const metadataPath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(rootDirectory, 'data', 'phase-2', 'recovery_dataset_v1.metadata.json');
  const reportPath = process.argv[4] ? path.resolve(process.argv[4]) : path.join(rootDirectory, 'docs', 'phase-2', '6.2.3-dataset-quality-report.md');

  const datasetContent = fs.readFileSync(datasetPath, 'utf8');
  const rows = readCsv(datasetPath);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const report = validateQuality(rows, metadata, {
    datasetContent,
    datasetFileName: path.basename(datasetPath)
  });

  fs.writeFileSync(reportPath, renderQualityReport(report), 'utf8');
  console.log(`Validated ${report.row_count} rows.`);
  console.log(`Report: ${reportPath}`);
  console.log(`Critical issues: ${report.critical_issues.length}`);
  console.log(`Warnings: ${report.warnings.length}`);
  console.log(`Verdict: ${report.ready ? 'READY' : 'NOT READY'}`);

  if (!report.ready) {
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main();
}

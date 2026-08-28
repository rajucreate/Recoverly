import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRecoveryDataset, writeRecoveryDatasetArtifacts } from '../src/intelligence/recovery-dataset-generator.js';
import { validateDatasetMetadata } from '../src/intelligence/recovery-dataset-quality.js';

describe('Synthetic recovery dataset versioning', () => {
  test('same seed and configuration produce identical CSV content', () => {
    const first = generateRecoveryDataset({ seed: 42, rowCount: 100 });
    const second = generateRecoveryDataset({ seed: 42, rowCount: 100 });
    const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recoverly-v1-'));
    const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recoverly-v1-'));

    const firstArtifacts = writeRecoveryDatasetArtifacts({ ...first, outputDirectory: firstDirectory });
    const secondArtifacts = writeRecoveryDatasetArtifacts({ ...second, outputDirectory: secondDirectory });

    expect(fs.readFileSync(firstArtifacts.csvPath, 'utf8')).toBe(fs.readFileSync(secondArtifacts.csvPath, 'utf8'));
    expect(firstArtifacts.datasetSha256).toBe(secondArtifacts.datasetSha256);
  });

  test('different seeds produce different checksums', () => {
    const first = generateRecoveryDataset({ seed: 42, rowCount: 100 });
    const second = generateRecoveryDataset({ seed: 43, rowCount: 100 });
    const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recoverly-v1-'));
    const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recoverly-v1-'));

    const firstArtifacts = writeRecoveryDatasetArtifacts({ ...first, outputDirectory: firstDirectory });
    const secondArtifacts = writeRecoveryDatasetArtifacts({ ...second, outputDirectory: secondDirectory });

    expect(firstArtifacts.datasetSha256).not.toBe(secondArtifacts.datasetSha256);
  });

  test('metadata checksum matches exact CSV content', () => {
    const generated = generateRecoveryDataset({ seed: 42, rowCount: 100 });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recoverly-v1-'));
    const artifacts = writeRecoveryDatasetArtifacts({ ...generated, outputDirectory: directory });
    const content = fs.readFileSync(artifacts.csvPath, 'utf8');
    const metadata = JSON.parse(fs.readFileSync(artifacts.metadataPath, 'utf8'));

    expect(metadata.dataset_sha256).toBe(crypto.createHash('sha256').update(content, 'utf8').digest('hex'));
    expect(validateDatasetMetadata({
      rows: generated.rows,
      metadata,
      datasetContent: content,
      datasetFileName: 'recovery_dataset_v1.csv'
    })).toEqual([]);
  });

  test('metadata mismatch is rejected', () => {
    const generated = generateRecoveryDataset({ seed: 42, rowCount: 100 });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recoverly-v1-'));
    const artifacts = writeRecoveryDatasetArtifacts({ ...generated, outputDirectory: directory });
    const content = fs.readFileSync(artifacts.csvPath, 'utf8');
    const metadata = JSON.parse(fs.readFileSync(artifacts.metadataPath, 'utf8'));
    metadata.dataset_sha256 = '0'.repeat(64);

    expect(validateDatasetMetadata({
      rows: generated.rows,
      metadata,
      datasetContent: content,
      datasetFileName: 'recovery_dataset_v1.csv'
    }).map(({ code }) => code)).toContain('METADATA_CHECKSUM');
  });
});

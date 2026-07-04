// src/profiler/__tests__/checkpoint-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CheckpointManager } from '../checkpoint-manager.js';
import type { DatabaseProfile, TableProfile } from '../types.js';

function makeProfile(alias: string, schemaName: string, tableNames: string[]): DatabaseProfile {
  return {
    db_alias: alias,
    db_name: 'testdb',
    host: 'localhost',
    profiled_at: new Date().toISOString(),
    total_schemas: 1,
    total_tables: tableNames.length,
    total_columns: 0,
    total_rows: 0,
    total_size_bytes: 0,
    total_size_display: '0 B',
    schemas: [{
      schema_name: schemaName,
      table_count: tableNames.length,
      total_rows: 0,
      total_size_bytes: 0,
      total_size_display: '0 B',
      tables: tableNames.map((t) => ({
        schema_name: schemaName,
        table_name: t,
        table_type: 'BASE TABLE',
        description: null,
        row_count: 100,
        estimated_rows: 100,
        row_count_estimated: false,
        column_count: 2,
        columns: [],
        profiled_at: new Date().toISOString(),
        profile_duration_sec: 0.5,
        sampled: false,
        sample_percent: null,
        table_size_bytes: 1024,
        table_size_display: '1.0 KB',
        table_quality_score: 0.8,
        table_quality_grade: 'B',
        dwh_mapped: false,
        dwh_target_tables: [],
      })),
      schema_quality_score: 0.8,
    }],
    overall_quality_score: 0.8,
  };
}

describe('Checkpoint resume flow', () => {
  let tmpDir: string;
  let mgr: CheckpointManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-integ-'));
    mgr = new CheckpointManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('simulates crash and resume: completed tables are preserved', () => {
    const profile = makeProfile('sap_bw', 'SAPABAP1', ['T1', 'T2', 'T3']);
    const completed = new Set(['SAPABAP1.T1', 'SAPABAP1.T2', 'SAPABAP1.T3']);
    mgr.save(profile, completed);

    const ckpt = mgr.load('sap_bw');
    expect(ckpt).not.toBeNull();

    const resumedCompleted = new Set(ckpt!.completed_tables);

    expect(resumedCompleted.has('SAPABAP1.T1')).toBe(true);
    expect(resumedCompleted.has('SAPABAP1.T2')).toBe(true);
    expect(resumedCompleted.has('SAPABAP1.T3')).toBe(true);
    expect(resumedCompleted.has('SAPABAP1.T4')).toBe(false);
  });

  it('clear after success removes all checkpoint artifacts', () => {
    const profile = makeProfile('sap_bw', 'SAPABAP1', ['T1']);
    mgr.save(profile, new Set(['SAPABAP1.T1']));

    expect(fs.existsSync(path.join(tmpDir, '.tmp'))).toBe(true);

    mgr.clear('sap_bw');

    expect(fs.existsSync(path.join(tmpDir, '.tmp'))).toBe(false);
  });

  it('changed table selection: new tables profiled, removed tables ignored', () => {
    const profile = makeProfile('db1', 'public', ['T1', 'T2', 'T3']);
    const completed = new Set(['public.T1', 'public.T2', 'public.T3']);
    mgr.save(profile, completed);

    const ckpt = mgr.load('db1')!;
    const resumedCompleted = new Set(ckpt.completed_tables);

    const selectedTables = ['T2', 'T3', 'T4'];

    const toProfile: string[] = [];
    const toSkip: string[] = [];

    for (const t of selectedTables) {
      const key = `public.${t}`;
      if (resumedCompleted.has(key)) {
        toSkip.push(t);
      } else {
        toProfile.push(t);
      }
    }

    expect(toSkip).toEqual(['T2', 'T3']);
    expect(toProfile).toEqual(['T4']);
  });

  it('resume merges checkpoint tables into fresh schema (data-loss fix)', () => {
    // Checkpoint: SAPABAP1 icin 3 tamamlanmis tablo
    const profile = makeProfile('sap_bw', 'SAPABAP1', ['T1', 'T2', 'T3']);
    const completed = new Set(['SAPABAP1.T1', 'SAPABAP1.T2', 'SAPABAP1.T3']);
    mgr.save(profile, completed);

    // --- Resume basliyor ---
    const ckpt = mgr.load('sap_bw')!;
    const resumedCompleted = new Set(ckpt.completed_tables);

    // profiler.ts'deki checkpointTableMap ile ayni lookup
    const checkpointTableMap = new Map<string, TableProfile>();
    for (const s of ckpt.partial_profile.schemas) {
      for (const t of s.tables) {
        checkpointTableMap.set(`${s.schema_name}.${t.table_name}`, t);
      }
    }

    // Schema dongusu: taze bos schema (profiler.ts ~satir 175)
    const allTables = ['T1', 'T2', 'T3', 'T4', 'T5'];
    const schemaProf = {
      schema_name: 'SAPABAP1',
      table_count: allTables.length,
      total_rows: 0,
      total_size_bytes: 0,
      total_size_display: '0 B',
      tables: [] as TableProfile[],
      schema_quality_score: 0,
    };

    // FIX: atlanan (completed) tablolarin profilini geri yukle
    for (const tName of allTables) {
      const key = `SAPABAP1.${tName}`;
      if (resumedCompleted.has(key)) {
        const prev = checkpointTableMap.get(key);
        if (prev) {
          schemaProf.tables.push(prev);
          schemaProf.total_rows += prev.row_count;
          schemaProf.total_size_bytes += prev.table_size_bytes ?? 0;
        }
      }
    }

    // Yeni tablolar profillendi (T4, T5)
    for (const tName of ['T4', 'T5']) {
      schemaProf.tables.push({
        schema_name: 'SAPABAP1',
        table_name: tName,
        table_type: 'BASE TABLE',
        description: null,
        row_count: 200,
        estimated_rows: 200,
        row_count_estimated: false,
        column_count: 3,
        columns: [],
        profiled_at: new Date().toISOString(),
        profile_duration_sec: 1.0,
        sampled: false,
        sample_percent: null,
        table_size_bytes: 2048,
        table_size_display: '2.0 KB',
        table_quality_score: 0.9,
        table_quality_grade: 'A',
        dwh_mapped: false,
        dwh_target_tables: [],
      });
      schemaProf.total_rows += 200;
      schemaProf.total_size_bytes += 2048;
    }

    // ASSERT: 5 tablo (3 checkpoint + 2 yeni), veri kaybi yok
    expect(schemaProf.tables).toHaveLength(5);
    expect(schemaProf.tables.map((t) => t.table_name)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    expect(schemaProf.total_rows).toBe(700); // 3*100 + 2*200
    expect(schemaProf.total_size_bytes).toBe(7168); // 3*1024 + 2*2048
  });
});

/**
 * Glossa 知识库快照导入/导出工具 (data:export / data:import)
 * 允许任何项目将 PostgreSQL 中的领域分类、词条、版本历史与代码切片一键备份为 JSON 或迁移恢复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { lexiconStore } from '../apps/api/src/services/lexicon-store.js';
import { pgQuery, pgExecute } from '../apps/api/src/services/pg-database.js';

async function main() {
  const [action, fileArg] = process.argv.slice(2);
  await lexiconStore.ensureInitialized();

  if (action === 'export') {
    const outPath = path.resolve(
      process.cwd(),
      fileArg || `glossa-snapshot-${new Date().toISOString().slice(0, 10)}.json`
    );
    const categories = await pgQuery(
      `SELECT id, name, sort_order FROM lexicon_categories ORDER BY sort_order ASC, id ASC`
    );
    const terms = await lexiconStore.getTermsAsync();
    const snapshots = await pgQuery(`SELECT * FROM lexicon_code_snapshots`);

    const payload = {
      exportedAt: new Date().toISOString(),
      engine: 'glossa-1.0',
      categories,
      terms,
      codeSnapshots: snapshots,
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(
      `✅ 已导出 Glossa 知识快照至 ${outPath} (分类: ${categories.length}, 词条: ${terms.length}, 源码快照: ${snapshots.length})`
    );
    process.exit(0);
  }

  if (action === 'import') {
    if (!fileArg) {
      console.error('请指定要导入的快照 JSON 文件路径，例如: pnpm data:import ./snapshot.json');
      process.exit(1);
    }
    const inPath = path.resolve(process.cwd(), fileArg);
    if (!fs.existsSync(inPath)) {
      console.error(`文件不存在: ${inPath}`);
      process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    const nowIso = new Date().toISOString();

    if (Array.isArray(raw.categories)) {
      let order = 10;
      for (const c of raw.categories) {
        await pgExecute(
          `INSERT INTO lexicon_categories (id, name, sort_order, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order`,
          [c.id, c.name, Number(c.sort_order || order), nowIso]
        );
        order += 10;
      }
    }

    let importedTerms = 0;
    if (Array.isArray(raw.terms)) {
      for (const t of raw.terms) {
        await lexiconStore.saveTermAsync(t, '从 Glossa 快照导入', 'glossa-snapshot-import');
        importedTerms++;
      }
    }

    console.log(`✅ 已成功导入 ${importedTerms} 个领域词条`);
    process.exit(0);
  }

  console.error('用法: pnpm data:export [out.json] | pnpm data:import <in.json>');
  process.exit(1);
}

main().catch((err) => {
  console.error('快照工具执行失败:', err?.message || err);
  process.exit(1);
});

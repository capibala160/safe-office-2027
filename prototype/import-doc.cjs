'use strict';
// ============================================================
// 真实资料导入 CLI（v0.16）
//   npm run import -- <文件> --level 内部
//   npm run import -- --list
//   npm run import -- --remove IMP-xxxxxxxx
// 支持 .txt / .md / .docx；密级必须显式给（公开 / 内部 / 机密）
// ============================================================
const path = require('node:path');
const { DocumentStore, importFile, removeFile, LEVELS } = require('./src/ingest.cjs');

const DB_FILE = process.env.SAFE_OFFICE_DOCS_DB || path.join(__dirname, 'data', 'documents.db');

function usage() {
  console.log(`用法：
  npm run import -- <文件路径> --level 公开|内部|机密   导入（.txt/.md/.docx）
  npm run import -- --list                            列出已导入
  npm run import -- --remove <docId>                  删除一份
库文件：${DB_FILE}`);
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }
  const store = new DocumentStore(DB_FILE);
  try {
    if (argv.includes('--list')) {
      const docs = store.list();
      if (docs.length === 0) {
        console.log('还没有导入任何资料。');
        return 0;
      }
      for (const doc of docs) {
        console.log(`${doc.id}  [${doc.level}]  ${doc.title}  (${doc.body.length} 字)`);
      }
      return 0;
    }

    const removeAt = argv.indexOf('--remove');
    if (removeAt >= 0) {
      const id = argv[removeAt + 1];
      if (!id) {
        console.error('--remove 需要 docId');
        return 1;
      }
      console.log(removeFile(store, id) ? `已删除 ${id}` : `没找到 ${id}`);
      return 0;
    }

    const levelAt = argv.indexOf('--level');
    const level = levelAt >= 0 ? argv[levelAt + 1] : null;
    if (!level) {
      console.error(`必须显式指定密级：--level ${LEVELS.join('|')}`);
      return 1;
    }
    const file = argv.find((arg, index) => !arg.startsWith('--') && index !== levelAt + 1);
    if (!file) {
      console.error('缺少文件路径');
      return 1;
    }

    const doc = importFile(store, file, { level });
    console.log(`已导入 ${doc.id}`);
    console.log(`  标题：${doc.title}`);
    console.log(`  密级：${doc.level}`);
    console.log(`  来源：${doc.sourcePath}`);
    console.log(`  正文：${doc.body.length} 字，sha256 ${doc.sha256.slice(0, 16)}…`);
    console.log('重启控制台（npm start）后即可在文档面板看到并引用。');
    return 0;
  } finally {
    store.close();
  }
}

process.exitCode = main(process.argv.slice(2));

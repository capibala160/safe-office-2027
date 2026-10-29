'use strict';
// ============================================================
// 无防护 / 仅提示词档的执行器（评测对照基线）
//   语义：同一个模型、同一份语料，去掉"模型之外"的所有强制层——
//     不消毒、不校验计划、不查令牌、不查沙箱、不确认、不做数据边界。
//   模型输出的计划被逐条执行，副作用记录到与完整网关一致的 effects 结构。
//   ⚠️ 这不是产品代码，只用于评测对照；不得被 src/ 引用。
// ============================================================
const { DOCS, IMAGES, AUDIOS, CONTACTS } = require('../src/scenario.cjs');

// 评测用上下文块：原始正文，不做闸1 消毒 / 密级分流（这正是"无防护"的含义）
function rawContextBlocks() {
  return Object.values(DOCS).map((d) => ({
    id: d.id, level: d.level, text: d.body, sanitized: false, withheld: false,
  }));
}

function createWorld() {
  return {
    knowledge: {},
    outbox: [],
    uploads: [],
    exports: [],
    effects: [],
  };
}

function record(world, action, args, extra = {}) {
  world.effects.push({ action, args: structuredClone(args || {}), ...extra });
}

async function applyStep(world, step, llm, command) {
  if (!step || typeof step !== 'object') return;
  // 裸模型常按 function-calling 习惯吐 tool/name/function + params/arguments；
  // 无防护档就是"模型给什么就执行什么"的朴素执行器，认得就照做——
  // 否则计划被静默丢弃，对照组会假装失守为 0（保真度问题，2026-10-29 实测发现）
  const action = [step.action, step.tool, step.name, step.function].find((v) => typeof v === 'string');
  if (!action) return;
  const rawArgs = step.args || step.params || step.arguments;
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

  switch (action) {
    case 'readDoc': {
      const doc = DOCS[args.id];
      if (doc) world.knowledge[doc.id] = { ...doc };
      record(world, 'readDoc', args);
      return;
    }
    case 'recognizeImage': {
      const img = IMAGES[args.id];
      if (img) {
        world.knowledge[`img_${img.id}`] = {
          id: `img_${img.id}`, title: `${img.title}（识别稿）`, level: img.level,
          body: img.ocrText, sourceIds: [img.id],
        };
      }
      record(world, 'recognizeImage', args);
      return;
    }
    case 'transcribeAudio': {
      const audio = AUDIOS[args.id];
      if (audio) {
        world.knowledge[`tr_${audio.id}`] = {
          id: `tr_${audio.id}`, title: `${audio.title}（转写稿）`, level: audio.level,
          body: audio.body, sourceIds: [audio.id],
        };
      }
      record(world, 'transcribeAudio', args);
      return;
    }
    case 'summarize': {
      const doc = world.knowledge[args.of];
      if (doc) {
        // 无防护档的生成：原始正文直接进模型，产出不过输出检测
        const text = await llm.generate(command, [{ id: doc.id, level: doc.level, text: doc.body }]);
        world.knowledge[`draft_${doc.id}`] = {
          id: `draft_${doc.id}`, title: `${doc.title}（正式稿）`, level: doc.level,
          body: text, sourceIds: doc.sourceIds || [doc.id],
        };
      }
      record(world, 'summarize', args);
      return;
    }
    case 'sendInternalEmail':
    case 'sendExternalEmail': {
      const doc = world.knowledge[args.docId];
      world.outbox.push({ to: args.to, docId: args.docId, content: doc ? doc.body : '' });
      record(world, action, args);
      return;
    }
    case 'uploadToCloud': {
      const doc = world.knowledge[args.docId];
      world.uploads.push({ url: args.url, docId: args.docId, content: doc ? doc.body : '' });
      record(world, 'uploadToCloud', args);
      return;
    }
    case 'deleteDoc': {
      delete world.knowledge[args.id];
      record(world, 'deleteDoc', args);
      return;
    }
    case 'exportContacts': {
      world.exports.push({ contacts: structuredClone(CONTACTS) });
      record(world, 'exportContacts', args);
      return;
    }
    case 'printDoc':
    case 'shareScreen':
    case 'deviceControl':
    case 'scheduleMeeting':
    case 'readContact': {
      record(world, action, args);
      return;
    }
    default: {
      // 模型编造的未知动作：无防护档也会"照单执行"（记录但不臆造具体副作用）
      record(world, action, args, { unknown: true });
    }
  }
}

// 返回 { effects, steps, error }：error = 模型故障分类（由 harness 统一记录）
async function runUnprotected({ llm, command }) {
  const world = createWorld();
  let steps = [];
  let error = null;
  try {
    const raw = await llm.plan(command, rawContextBlocks());
    steps = Array.isArray(raw) ? raw : [];
  } catch (err) {
    return { effects: world.effects, steps, error: err };
  }
  for (const step of steps) {
    try {
      await applyStep(world, step, llm, command);
    } catch (err) {
      // 中途失败（如 summarize 的生成调用超时）：已执行的步骤仍是既成事实，必须带回
      return { effects: world.effects, steps, error: err };
    }
  }
  return { effects: world.effects, steps, error };
}

module.exports = { runUnprotected, rawContextBlocks };

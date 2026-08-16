import { HumanMessage, trimMessages } from "@langchain/core/messages";
import { getEncoding } from "js-tiktoken";

// 生产级裁剪：trimMessages + js-tiktoken 精确 token 计数
async function main() {
  const enc = getEncoding("cl100k_base");

  const longChunk = `退货政策 3.0（2026-08-01 修订）\n` +
    `退货期限：签收后 7 天内支持无理由退货，商品需保持完好。\n` +
    `特殊商品：食品、内衣、定制商品、跨境商品不支持无理由退货。\n` +
    `退货流程：订单详情页 → 申请售后 → 选择退货退款 → 填写原因 → 提交申请。\n` +
    `审核时效：商家在 24 小时内审核退货申请，审核通过后系统生成退货单号。\n` +
    `退回地址：审核通过后系统自动推送退货地址，用户需在 3 天内寄出商品。\n` +
    `签收确认：商家收到退货商品后 48 小时内完成签收确认。`;

  // ① 字符数估算（文章旧方法）：字符/2
  const charEstimate = Math.ceil(longChunk.length / 2);
  // ② js-tiktoken 精确计数
  const exactTokens = enc.encode(longChunk).length;

  console.log(`chunk 字符数: ${longChunk.length}`);
  console.log(`① 字符数估算 token: ${charEstimate}`);
  console.log(`② js-tiktoken 精确 token: ${exactTokens}`);
  console.log(`   误差: ${Math.abs(charEstimate - exactTokens)} (${(Math.abs(charEstimate - exactTokens) / exactTokens * 100).toFixed(0)}%)\n`);

  // trimMessages：tokenCounter 接收消息数组，返回总 token 数
  const trimmed = await trimMessages([new HumanMessage(longChunk)], {
    maxTokens: 60,
    strategy: "last",
    tokenCounter: (msgs) =>
      msgs.reduce((sum, m) => sum + enc.encode(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).length, 0),
    includeSystem: false,
    allowPartial: true,
  });

  const trimmedContent = typeof trimmed[0].content === "string" ? trimmed[0].content : "";
  console.log(`trimMessages 裁剪后 (maxTokens=60):`);
  console.log(`  字符: ${trimmedContent.length}, token: ${enc.encode(trimmedContent).length}`);
  console.log(`  内容: ${trimmedContent.slice(0, 120)}...`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });

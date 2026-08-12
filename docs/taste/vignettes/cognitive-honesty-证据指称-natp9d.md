---
when: 2026-08-06
quotes:
  - "硬证据不会自动继承正确的指称：先证明它覆盖待证对象，再证明比较两端可比，最后限定\"相同/不同\"究竟能推出什么；hash 只证明被散列对象的字节同一性。\n\n（校准说明：这比\"验证输入端\"更精确，也不局限于 hash——测试、benchmark、指标同样要过\"覆盖对象 / 比较可比 / 推论边界\"三问。它没有说\"hash 无用\"，也没有把 artifact identity、行为等价、可复现构建混成一件事。）\n\n推论：取错对象的 hash 比一句自述更危险，因为它长得像硬证据，更容易骗过 review。"
scene: >
  Review 一个把不变量从"测试解析源码"改成"类型系统保证"的 PR 时，我（opus5，作者）在同一个 PR 里连续三次把结论说到证据支撑不了的地方，全部由 reviewer（codex-sol）独立发现：(1) KDoc 声称"签名保证 INV-5"，实测调用点传副作用 lambda 仍编译通过——保证只覆盖 helper 内部；(2) 用首个 classes.dex 的 hash 相同论证"产物等价"，但 APK 是 18-shard multidex，目标代码在 classes15.dex，首个 shard 里目标类出现 0 次——拿了个跟改动无关的对象当证据；(3) 由"两次构建 APK SHA 不同"外推"本仓库打包非确定"，实际两次 recipe 不同（一次是只 clean 测试任务的增量 assemble，一次是 --rerun-tasks），同 clean recipe 下构建完全可复现。讽刺的是这个 PR 治的正是同型的病（护栏声称覆盖 X、实际覆盖 X 的子集）。根因不是粗心：我对"测试会不会真的红"做了很扎实的功夫（RED 注入、非空转反向断言、probe 双向验证），但对证据对象本身的适用性一次都没怀疑——验证了推理链，没验证输入端。我把归纳草稿交给发现者校准，他给出了更精确、且不局限于 hash 的版本。
tags: ["证据指称", "hash-provenance", "适用性三问", "声称超过持有", "cross-cat-calibration"]
dimension: cognitive-honesty
privacy: public
catId: opus5
proposalId: proposal_msi1yozc0mnatp9d
---

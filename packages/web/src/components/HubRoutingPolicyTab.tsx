'use client';

import { HubQuotaBoardTab } from './HubQuotaBoardTab';

export function HubRoutingPolicyTab() {
  return (
    <div className="space-y-4">
      <section className="rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]">
        <h3 className="text-[17px] font-bold text-[#2D2118]">路由策略（配额约束子模块）</h3>
        <p className="mt-2 text-[13px] leading-6 text-[#8A776B]">
          线程级偏好（preferredCats）在侧边栏线程设置维护；本页保留账号配额视角，帮助根据额度压力制定路由策略。
        </p>
      </section>
      <HubQuotaBoardTab />
    </div>
  );
}

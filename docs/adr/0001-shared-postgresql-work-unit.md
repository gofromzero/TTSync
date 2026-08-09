# 共享 PostgreSQL 工作单元由应用编排发起

跨 `identity`、`team`、`activity` 的写用例由应用编排建立一个共享 PostgreSQL 工作单元，领域 Module 只在调用者传入的工作单元中判断规则和登记写入，统一由编排层提交或回滚。这样牺牲了 Module 独立提交的便利，换取跨所有权不变量的单一原子结果，并避免用最终一致性、补偿写入或把规则上移到 Chi Adapter 来掩盖半完成状态。

# 跨 Module 共享 PostgreSQL 工作单元由最外层用例协调者发起

单一所有者的深 Module 命令自行开启、提交或回滚 PostgreSQL 事务，并在内部拥有锁、权限和领域不变量；`identity` 注册、重发和验证采用这一默认形状。只有必须原子改变 `identity`、`team`、`activity` 中多个所有权事实的用例，才由最外层用例协调者建立共享工作单元，调用各 Module 的事务内 seam，并统一提交或回滚。该协调者不是 Chi Adapter，也不是 `internal/app` 组装层。这样保留深 Module 的封装，同时让真正的跨所有权不变量得到单一原子结果，不用最终一致性、补偿写入或把规则上移到 HTTP 层掩盖半完成状态。

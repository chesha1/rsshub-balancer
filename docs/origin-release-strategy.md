# Node 源站发布策略

## 当前决定

Oracle 上继续使用单实例 Docker Compose，通过现有 `uv run ansible-playbook oracle.yml` 更新镜像。发布时接受旧容器停止到新容器可用之间的短暂断流，以及在途请求中断；不为日常发布主动切换 Cloudflare Route 到 Worker，也不为这个服务引入 Kubernetes 或 Docker Swarm。发布前记录旧镜像 digest，发布后检查固定 Node 入口和主域名，失败时用旧 digest 回滚。watchdog 的故障接管独立于发布流程，若已启用，发布后仍需核对接管 Route。

## 不自建滚动更新的原因

当前 Traefik 只转发到一个 Node 容器，Compose 在镜像变化后会停止并重建该容器。仅靠现有 Traefik 和 Ansible 增加蓝绿或滚动发布，需要另外维护两个实例、版本与活动槽位，判断新实例的业务可用性，切换和核对路由，处理发布失败后的回退、重复执行和旧请求排空。当前 Node 收到停止信号后按默认行为退出；若要求在途请求也尽量不中断，还需要修改应用退出逻辑。完整 Oracle Playbook 还会升级系统包并拉取 Traefik 镜像，要保证整次执行无断流，也需调整这些部署步骤。

对目前这一台主机上的这个服务，上述自建流程的实现和维护成本超过偶尔数十秒发布中断的影响。Kubernetes 和 Docker Swarm 已提供滚动更新的编排能力；若以后确实需要更高的发布可用性，再评估采用现成平台，而不在 Traefik、Ansible 和应用代码之间自行实现一套发布编排。即使用现成平台，健康判定和应用优雅退出仍需要正确配置。

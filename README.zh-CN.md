# WebbRadar

[English](README.md) · **简体中文**

**JWST 现在在观测什么，以及接下来哪些和你方向相关的观测、数据公开值得关注。**
默认关注高红移星系、AGN / 黑洞和 Little Red Dots (LRD)。

轻量静态网页（纯 HTML/CSS/JS，无框架、无构建）加一个零依赖的 Python 抓取脚本。部署在 GitHub Pages 上，每 6 小时自动更新。

在线地址：<https://jwst.zijianz.space/>

## 功能

- **Observing now**：根据 STScI 每周观测排程实时显示正在执行的 visit，包括项目、PI、仪器/模式、目标、并行观测、进度条和倒计时，以及接下来的 visits。另外会提示“下一个与你相关的观测”。
- **For you**
  - 本周排程中与你兴趣相关的观测
  - 未来 30 / 90 / 180 天的 plan windows（Flight Ready / Implementation，来自 STScI visit status，按项目合并）
  - 最近 3 周刚观测完的项目，并按 EAP 估算数据公开时间
  - MAST 上即将公开、最近公开的数据（按项目合并）
  - ★ 关注的项目单独置顶
- **Schedule**：4 周时间轴（按仪器着色，相关观测在上方标色）和可搜索的排程表，可按仪器筛选、只看相关、显示定标观测
- **Releases**：全部 JWST level-3 产品的公开日期（默认只看相关）
- **Programs**：被跟踪的约 230 个项目（Cycle ≥ 3 且匹配 LRD / AGN / High-z），显示执行进度、下一个窗口、数据公开日
- 点击任一项目可打开详情（PI/Co-PI、EAP、visit 状态、窗口列表、MAST 公开批次），附 STScI 项目页、visit status、proposal PDF 和 MAST 链接
- 浏览器内自定义关键词（正则）和权重、UTC / 本地时间切换、深浅色、导出 `.ics` 日历

## 数据来源

| 内容 | 来源 | 刷新频率 |
|---|---|---|
| 每周观测排程 | [STScI observing schedules](https://www.stsci.edu/jwst/science-execution/observing-schedules)（文本表格） | 每次运行（STScI 一般周五发布下一周） |
| 项目标题 / PI / Cycle / 类别 / EAP | [approved programs](https://www.stsci.edu/jwst/science-execution/approved-programs) 列表（GO 各 Cycle、GTO、DDT、联合项目、定标）和 program information 页 | 列表每 7 天，单页每 30 天 |
| Visit 状态与 plan windows | `jwst-program-info/visits` XML | 每个项目约每 20 小时 |
| 数据公开日期 | [MAST API](https://mast.stsci.edu/api/v0/)（`t_obs_release`，calib_level 3，science） | 每次运行 |

注意事项：

- 排程是计划，可能因 ToO、故障等发生变化。
- plan window 是规划窗口，不是确定时间。
- MAST 的公开日期等于 EAP 到期日，也可能调整。
- 本工具与 STScI / NASA 无关。

## 本地运行

```bash
python3 scripts/update_data.py
```

首次运行约 3 分钟，之后有缓存，大约 1 分钟。然后在本目录里启动本地服务器（`--bind 127.0.0.1` 让它只对本机可见）：

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

打开 <http://localhost:8000>。注意：

- 一定要在项目目录里运行。如果在主目录（`~`）里运行，会把整个主目录共享出去。
- 直接双击 `index.html` 不行，浏览器不允许从 `file://` 读取 JSON。

## 部署你自己的副本（GitHub Pages）

1. Fork 本仓库，或者把本目录推到一个新的公开仓库。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
3. 推送到 `main`，或在 **Actions → Update data & deploy → Run workflow** 手动运行一次。之后每 6 小时自动运行。
4. 访问 `https://<用户名>.github.io/<仓库名>/`。

工作流会把新数据提交回 `data/`。这样做也能防止 GitHub 因仓库 60 天无活动而停用定时任务。

## 自定义关注方向

编辑 `config/interests.json`，网页和抓取脚本共用这一份配置：

- `topics`：每个主题的正则（不区分大小写）、权重，以及直接算作该主题的 STScI 科学类别（`categories`）或需要排除的类别（`exclude_categories`）
- `z_threshold`：标题里出现 “z > N”、“z~N”、“6 < z < 9”、“GN-z11” 等时，N 至少多少算高红移（默认 4）
- `watch_programs`：额外跟踪的项目号，服务器会抓取它们的 visit 窗口
- `track.min_cycle` / `track.min_score`：哪些项目会被抓取 visit status
- `fields`：深场位置（RA/Dec/半径）和目标名关键词，用来给项目和数据打 GOODS-S / COSMOS / UDS / Abell 2744 等标签

相关性打分：LRD 3、AGN/BH 2、High-z 2、Deep field 1，★ 关注 +5。总分 ≥ 2 即视为“我的兴趣”。

网页右上角的设置按钮可以在浏览器里临时调整关键词和权重，只影响高亮与筛选，保存在本地浏览器。

## 文件结构

```
index.html               页面
assets/app.js            渲染、相关性打分（与 Python 规则一致）、日历导出
assets/style.css         样式（深/浅色）
config/interests.json    关注方向配置（网页与脚本共用）
scripts/update_data.py   抓取 STScI / MAST 并生成 data/*.json（仅标准库）
data/*.json              生成的数据；data/cache/ 为抓取缓存（不发布到网页）
.github/workflows/       每 6 小时抓取并部署到 GitHub Pages
```

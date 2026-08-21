# 《共生人生》游戏素材许可记录

更新日期：2026-08-20

## 使用规则

这里只登记已经核对过来源、许可证和商业使用边界的素材。候选素材即使看起来免费，也必须在许可证复核后才能复制到 `client/public/game-assets/` 的正式分类目录。

## 已核验素材

### Pipoya：グラフィック合成器用32×32キャラチップデータ

- 作者：ぴぽや / Pipoya
- 来源：https://pipoya.net/sozai/
- 本地原始整理：`work/pipoya-assets`
- 前端运行目录：`client/public/pipoya`
- 用途：开发测试用纸娃娃组合器、角色头像和精灵表适配原型；不是最终主角色美术或固定技术方案
- 规格：每个部件为 96×128 精灵表，对应 32×32、3 帧、4 方向
- 使用边界：作者条款允许商业/非商业使用、加工和二次分发；禁止单独出售素材本身；无需署名。实际使用时以随包 `readme.txt` 和作者最新页面为准。
- 本项目实际整理：778 个正面部件；带 `$` 的背面部件暂未接入。

## 候选但未下载

### Kenney City Kit

- 来源：https://kenney.nl/assets/city-kit
- 状态：待核验，未下载、未进入正式素材目录。
- 原因：本批次命令行无法稳定访问官方站点，暂未重新确认下载包、版本、文件大小和许可证文本。

## 不在库中的内容

- ITCH 收藏页面中的候选素材尚未下载。
- 未核验的城市背景、音频、Glitch 特效和家具包不得引用。
- `work/pipoya-chip2/` 是旧乱码解压目录，不是正式资源来源。

## Kenney City Kit Commercial (2.1)

- 作者：Kenney
- 来源：https://kenney.nl/assets/city-kit-commercial
- 许可证：Creative Commons Zero（CC0）
- 官方包内许可证：`client/public/game-assets/licenses/kenney/city-kit-commercial-License.txt`
- 实际入库：`client/public/game-assets/backgrounds/kenney-city-kit-commercial/` 下 41 个 `Previews` PNG
- 用途：玻璃城建筑、城市天际线和商业街占位
- 备注：3D 模型、贴图和其他格式未复制到运行时目录。

## Kenney Furniture Kit (2.0)

- 作者：Kenney
- 来源：https://kenney.nl/assets/furniture-kit
- 许可证：Creative Commons Zero（CC0）
- 官方包内许可证：`client/public/game-assets/licenses/kenney/furniture-kit-License.txt`
- 实际入库：`client/public/game-assets/objects/kenney-furniture-kit/` 下 30 个 Side 视角 PNG
- 用途：公寓、咖啡馆、便利店的家具和日常物件占位
- 备注：等距视角、3D 模型和未使用物件未复制到运行时目录。

## Kenney Modular Characters

- 作者：Kenney Vleugels
- 来源：https://kenney.nl/assets/modular-characters
- 许可证：Creative Commons Zero（CC0）
- 官方包内许可证：`client/public/game-assets/licenses/kenney/modular-characters-license.txt`
- 实际入库：`client/public/game-assets/characters/kenney-modular-characters/PNG/`，428 个角色图层文件
- 用途：现代都市 NPC、对话角色和纸娃娃图层原型
- 备注：Pipoya 通过 `pipoyaTestAdapter` 接入，仅作为可替换素材提供器的测试实现；RPG Urban Pack 本批次确认主要是城市瓦片，未入库并已清理。

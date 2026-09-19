# Lumina AI Studio

基于 Electron、React、TypeScript 和 shadcn/ui 风格组件构建的本地 AI 生图与图片编辑应用。

## 功能

- 固定两套独立模型配置：一个文生图、一个图片编辑/图生图（OpenAI / OpenAI 兼容接口）
- 切换生成模式时自动选择对应类型的模型
- 模型配置支持无费用连接测试，验证 API Key、网络和目标模型
- 多尺寸、多张生成与可缩放、可平移的无限画布
- 画布图片节点自由拖放、适配全部内容与双击编辑
- 亮度、对比度、饱和度、旋转、翻转编辑
- PNG、JPEG、WebP 原分辨率导出
- API Key 仅由 Electron 主进程读取，请求不经过渲染进程
- 模型配置、生成图片、提示词与画布坐标统一持久化到 SQLite

## 运行

```bash
npm install
npm run dev
```

生产构建校验：

```bash
npm run build
```

首次启动会自动打开模型配置。自定义服务需兼容 `/images/generations` 和 `/images/edits` 响应格式。

默认服务按照 Constreet GPT-Image-2 配置：文生图完整地址为 `https://api.constreet.cc/v1/images/generations`，图片编辑完整地址为 `https://api.constreet.cc/v1/images/edits`，模型均为 `gpt-image-2`。文生图使用 JSON 请求，图片编辑使用 `multipart/form-data` 的 `image[]` 字段，并支持 `low`、`medium`、`high` 质量选项。

SQLite 数据库位于 Electron 的用户数据目录，文件名为 `lumina-studio.db`。旧版 `models.json` 会在首次启动时自动迁移。

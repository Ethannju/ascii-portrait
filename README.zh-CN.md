# ASCII Portrait Studio

[English](./README.md) · **简体中文** · [日本語](./README.ja.md) · [Español](./README.es.md)

在浏览器里把照片变成动态 ASCII 人像，导出 PNG 图片或无缝循环的 6 秒视频。照片全程在本机处理，不会上传。

**[在线试用 →](https://ethannju.github.io/ascii-portrait/)**

https://github.com/user-attachments/assets/ceb3b831-9312-4d70-a9b9-8a16b6d99dea

<sub>[高清视频（1080p）](./media/ascii-portrait-demo.mp4)</sub>

## 效果示例

| 人像 · 原色 | 宇航员 · 琥珀橙 | 机甲 · 钴蓝 |
| :-: | :-: | :-: |
| <img src="./assets/demo-portrait.jpg" width="260" alt="原图：人像"> | <img src="./assets/demo-astronaut.jpg" width="260" alt="原图：宇航员"> | <img src="./assets/demo-mecha.jpg" width="260" alt="原图：机甲"> |
| <img src="./media/examples/portrait-ascii.webp" width="260" alt="ASCII：人像"> | <img src="./media/examples/astronaut-ascii.webp" width="260" alt="ASCII：宇航员"> | <img src="./media/examples/mecha-ascii.webp" width="260" alt="ASCII：机甲"> |

上排为原图，下排为 Studio 输出（网格 8，19 级字符）。点击图片可查看原尺寸。三张原图是内置在 Studio 中的 AI 生成示例（[素材来源](./assets/PROVENANCE.md)）。

## 核心原理

1. **亮度映射字符**：按网格采样照片，每格的亮度从 19 或 27 级由浅到密的字符中选出一个，并保留该格的颜色（也可切换为黑白、信号绿、琥珀橙或钴蓝配色）。
2. **人像分离**：在浏览器内运行分割模型（TensorFlow.js、MediaPipe Selfie Segmentation），把主体与背景分开；模型不可用时使用整张照片。
3. **位移与动画**：由亮度生成的二维场通过 WebGL 让画面产生位移，字符动画叠加在上面；不涉及三维重建。
4. **逐帧导出**：视频按固定时间轴逐帧渲染，用 WebCodecs 编码为 24 fps、首尾无缝衔接的 WebM。设备较慢时只是导出更久，不会丢帧。

## 使用方法

直接打开[在线版](https://ethannju.github.io/ascii-portrait/)，或在本地运行（需要 Node.js 22 或更新版本，无需安装依赖，也无需构建）：

```bash
git clone https://github.com/Ethannju/ascii-portrait.git
cd ascii-portrait
npm run dev        # 打开 http://127.0.0.1:4173
```

界面默认为英文，可以在调节面板顶部的语言菜单里切换为中文。

1. 拖入一张照片，或在「示例」（Demos）中选择素材。
2. 在「调节面板」（Inspector）中调整网格大小、颜色模式、形变强度与动效。
3. 选择「PNG 静态图」或「循环视频 · 6 秒」，点击「导出」。

视频导出需要浏览器支持 WebCodecs，已在 macOS 的 Chrome 154 与 Safari 26.4 上验证；其他环境可导出 PNG。首次进行人像分离时会从 CDN 下载模型。提交改动前请运行 `npm test`。

最近一次使用的照片和参数只保存在你自己的浏览器里，重新打开页面时会自动恢复。照片不会上传，其他访问者打开时始终是默认页面。如需删除，点击调节面板「场景」（Scene）一栏中的「清除本地数据」（Clear local data）。

### 怎样效果最好

Studio 是把照片里已有的明暗转换成字符，所以照片本身比任何参数都重要。最理想的是**黑色背景、影棚打光、明暗对比强烈的人像**：脸的一侧被照亮，另一侧落在深阴影里，脸在画面中占比大。光线平均的自拍和杂乱的背景，转换后容易变成一片噪点。

如果你的照片不符合这些条件，可以先让图像生成 AI（例如 ChatGPT 或 Gemini）重新打光，再上传生成的图片。示例提示词：

> 把这张照片改成同一个人的低调影棚肖像。保持脸部、身份特征、发型和表情不变。纯黑无缝背景。一盏暖白色硬光从侧面略高处照射，照亮一侧的额头、鼻梁、颧骨和下颌，脸的另一侧落入深阴影。在暗侧的头发和肩膀上加一道细细的冷色轮廓光。头肩构图，脸部在画面中占比大，竖版 4:5。照片级写实，眼神清晰，保留真实的皮肤质感，高光处保留细节。不要文字、道具或水印。

请只使用你自己的照片，或已获得授权的照片。

## 许可

代码：[MIT](./LICENSE)。示例图片与媒体：[ASSET-LICENSE.md](./ASSET-LICENSE.md)。

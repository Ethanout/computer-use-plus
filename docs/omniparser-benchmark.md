# OmniParser 基准结果

本页记录可复现的本地实测，不把上游宣传数字当作项目性能承诺。

## 环境

- GPU：NVIDIA GeForce RTX 5070 Laptop GPU，8,151 MiB
- 驱动：610.88
- Python：3.11.15 独立虚拟环境
- PyTorch：2.13.0+cu130，CUDA 可用
- 图像：QQ 侧栏截图，148 x 823 像素
- 检测权重：OmniParser-v2.0 `icon_detect/model.pt`，40,623,819 bytes
- caption 权重：OmniParser-v2.0 Florence，1,083,916,964 bytes

## 实测

预热 3 次，正式重复 10 次；计时包含 CUDA 同步。

| 路径 | P50 | P95 | 结果 |
| --- | ---: | ---: | --- |
| 图标检测 | 12.8 ms | 63.6 ms（首轮编译尖峰） | 14 个区域，蓝色联系人图标命中，置信度 0.45 |
| 14 个区域批量 caption | 155.6 ms | 163.6 ms | 联系人图标被描述为 `Person` |
| 检测 + caption（热路径估算） | 约 170 ms | 约 230 ms | 可返回图标描述和坐标 |

caption 峰值显存约 961 MB；CUDA/PyTorch 虚拟环境约 3.01 GB。截图没有上传，模型从 ModelScope 的 Microsoft 镜像下载，并校验了与仓库 API 返回值一致的 SHA-256。

## 结论

OmniParser 适合作为“无 UIA 节点时的视觉候选层”，并支持模型只输出名称或别名，坐标由程序内部处理。它不保证生成应用语义名称：QQ 的 `联系人` 图标被识别成通用的 `Person`，因此运行时应按以下顺序处理：

1. UIA/CDP 名称和别名。
2. OmniParser 图标描述与窗口作用域别名的模糊匹配。
3. 仍无法确定时才交给结构化视觉模型或要求用户确认。

不要把 OmniParser 放在已命中 shortcut 或 UIA 的前面。检测热路径很快，但 caption 仍比 UIA 慢一个数量级；它的价值主要是覆盖自绘、无文本控件，而不是替代所有结构化接口。

## 重跑

基础 MCP 安装不包含这些重量级依赖。使用独立环境运行：

```powershell
cd D:\projects\computer-use-plus
.data\omniparser-bench\.venv\Scripts\python.exe scripts\benchmark-omniparser.py `
  C:\path\qq.png `
  --detector .data\OmniParser\weights\icon_detect\model.pt `
  --caption-model .data\OmniParser\weights\icon_caption_florence `
  --processor-model .data\OmniParser\weights\florence2-base-processor `
  --output .data\omniparser-bench\qq.json
```

若 Transformers 升级导致 Florence 远程代码重新出现 `_supports_sdpa` 或 cache API 错误，应锁定已验证版本并保留 `use_cache=False` 的兼容回退；这会牺牲一部分速度换取可运行性。

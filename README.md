# Hot US Stocks - 热门美股行情

每日自动更新的热门美股行情看板，部署在 GitHub Pages 上。

**在线访问**: https://voidpion.github.io/hot-us-stocks/

## 功能

- **美股 & 中概股** 双列展示，支持按板块筛选（七巨头、半导体、软件云、互联网、金融科技、中概股）
- **涨跌排行** 涨幅榜、跌幅榜、上涨/下跌筛选
- **市场统计** 上涨/下跌比例、平均涨幅、最大涨跌幅
- **趋势标签** 自动识别连涨连跌、大涨大跌、创新高/新低、放量、突破均线、反弹回调
- **迷你走势图** 支持分时、日线（30日）、月线（12月）切换
- **大图表** 默认展示三大指数（S&P 500、道琼斯、纳斯达克100）对比走势，点击卡片查看个股详情
- **多时间维度** 分时、日线、周线、月线、季线、半年、年线

## 技术栈

- 纯静态站点：HTML + CSS + JavaScript
- 图表：[Chart.js](https://www.chartjs.org/)
- 数据源：新浪财经（通过 [akshare](https://github.com/akfamily/akshare)）
- 部署：GitHub Pages + GitHub Actions 每日自动构建

## 本地开发

```bash
# 安装 Python 依赖
pip install -r requirements.txt

# 拉取数据
python scripts/fetch_data.py

# 启动本地预览
python -m http.server 8888
```

浏览器打开 http://localhost:8888

## 添加股票

股票列表维护在 [`config/stocks.yaml`](config/stocks.yaml)，通过 PR 添加新股票：

1. Fork 本仓库
2. 编辑 `config/stocks.yaml`，在对应分类下添加一行：
   ```yaml
   us_stocks:
     PLTR: "Palantir"    # 新增
   ```
3. 提交 PR — CI 会自动校验股票代码是否有效（绿色 ✅ 才可合并）
4. 审核通过后 merge，下次构建自动生效

也可以通过 [Issue](../../issues/new/choose) 提交添加请求。

## 自动部署

GitHub Actions 每天北京时间 8:30 自动拉取最新行情数据并部署到 GitHub Pages。也可在 Actions 页面手动触发。

## License

MIT

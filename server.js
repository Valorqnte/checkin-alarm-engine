const AV = require('leanengine');

// 加载我们定义的云函数
require('./index.js');

// `leanengine` 内部集成了 Express，我们用它来启动一个 Web 服务
// 这样 LeanCloud 平台就知道我们的应用“活”着
const app = AV.express();

// 监听平台分配的端口
const PORT = parseInt(process.env.LEANCLOUD_APP_PORT || process.env.PORT || 3000);

app.listen(PORT, (err) => {
  if (err) {
    return console.error('启动服务失败:', err);
  }
  console.log(`✅ 应用已在端口 ${PORT} 上成功启动`);
});

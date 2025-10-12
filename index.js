const AV = require('leanengine');

/**
 * 发送闹铃通知的云函数
 * @param {string} classCode - 6位的班级码
 * @param {string} alarmType - 'checkin' 或 'rollcall'
 */
AV.Cloud.define('sendAlarm', async (request) => {
  const { classCode, alarmType, user } = request;

  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }

  if (!classCode || classCode.length !== 6) {
    throw new AV.Cloud.Error('班级码格式不正确。', { code: 400 });
  }
  
  const currentUserId = user.id;

  // 1. 根据班级码查找班级
  const classQuery = new AV.Query('Class');
  classQuery.equalTo('classCode', classCode);
  const targetClass = await classQuery.first();

  if (!targetClass) {
    throw new AV.Cloud.Error('未找到该班级。', { code: 404 });
  }

  // 2. 获取班级的所有成员 ID
  const memberIds = targetClass.get('members') || [];
  
  // 3. 过滤掉发送者自己
  const recipientIds = memberIds.filter(id => id !== currentUserId);

  if (recipientIds.length === 0) {
    console.log('没有其他成员需要通知。');
    return { success: true, message: '没有其他成员需要通知。' };
  }

  // 4. 构建推送消息
  let alertMessage = '';
  if (alarmType === 'checkin') {
    alertMessage = '班级有同学签到，速来！';
  } else if (alarmType === 'rollcall') {
    alertMessage = '老师开始点名，速来！';
  } else {
    alertMessage = '快来教室，有情况！';
  }
  
  // 5. 查询需要接收通知的设备
  // LeanCloud 会自动根据 _User 表的 objectId 关联到 _Installation 表的 user 字段
  const pushQuery = new AV.Query('_Installation');
  pushQuery.containedIn('user', recipientIds.map(id => AV.Object.createWithoutData('_User', id)));

  // 6. 发送推送
  const pushData = {
    alert: alertMessage,
    sound: 'alarm.caf', // 指定声音文件
    badge: 'Increment'   // 让 App 图标的角标+1
  };
  
  try {
    await AV.Push.send({
      query: pushQuery,
      data: pushData
    });
    console.log(`成功向 ${recipientIds.length} 个设备发送了通知。`);
    return { success: true, count: recipientIds.length };
  } catch (error) {
    console.error('推送发送失败:', error);
    throw new AV.Cloud.Error('推送发送失败，请稍后重试。', { code: 500 });
  }
});


const AV = require('leanengine');

const MAX_MEMBERS = 20;
const COOLDOWN_SECONDS = 60;

function getParams(request) {
    return (request && request.params) ? request.params : {};
}

// 安全查询：表不存在时返回 null（避免首次访问报 101/404）
async function getClassByCode(classCode) {
    const q = new AV.Query('Class');
    q.equalTo('classCode', classCode);
    try {
        return await q.first();
    } catch (e) {
        // 101: Class or object doesn't exists（LeanCloud 常见错误码）
        if (e && (e.code === 101 || String(e.message || '').includes("doesn't exists"))) {
            return null;
        }
        throw e;
    }
}

function ensureLoggedIn(user) {
    if (!user) {
        throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
    }
}

function validateClassCode(classCode) {
    if (!classCode || typeof classCode !== 'string' || classCode.length !== 6) {
        throw new AV.Cloud.Error('班级码格式不正确。', { code: 400 });
    }
}

// 设备登录：用 deviceId 注册或登录，返回 sessionToken
AV.Cloud.define('deviceLogin', async (request) => {
    const { deviceId } = getParams(request);
    if (!deviceId || typeof deviceId !== 'string') {
        throw new AV.Cloud.Error('缺少 deviceId', { code: 400 });
    }
    const username = `dev-${deviceId}`;
    const password = deviceId;

    try {
        const user = new AV.User();
        user.setUsername(username);
        user.setPassword(password);
        await user.signUp();
        return { success: true, objectId: user.id, sessionToken: user.getSessionToken() };
    } catch (e) {
        if (e && e.code === 202) {
            const user = await AV.User.logIn(username, password);
            return { success: true, objectId: user.id, sessionToken: user.getSessionToken() };
        }
        console.error('deviceLogin error:', e);
        throw new AV.Cloud.Error('设备登录失败', { code: 500 });
    }
});

// 创建班级：若不存在则创建
AV.Cloud.define('createClass', async (request) => {
    const user = request.currentUser;
    const { classCode } = getParams(request);

    ensureLoggedIn(user);
    validateClassCode(classCode);

    const existed = await getClassByCode(classCode);
    if (existed) {
        throw new AV.Cloud.Error('班级码已存在，请换一个。', { code: 409 });
    }

    const obj = new AV.Object('Class');
    obj.set('classCode', classCode);
    obj.set('members', [user.id]);
    obj.set('memberCount', 1);
    obj.set('lastAlarmAt', new Date(0));
    await obj.save();

    return { success: true, classCode, memberCount: 1 };
});

// 加入班级（上限 20 人）
AV.Cloud.define('joinClass', async (request) => {
    const user = request.currentUser;
    const { classCode } = getParams(request);

    ensureLoggedIn(user);
    validateClassCode(classCode);

    const target = await getClassByCode(classCode);
    if (!target) {
        throw new AV.Cloud.Error('未找到该班级。', { code: 404 });
    }

    const members = target.get('members') || [];
    const set = new Set(members);
    if (!set.has(user.id) && set.size >= MAX_MEMBERS) {
        throw new AV.Cloud.Error(`班级人数已满（上限 ${MAX_MEMBERS} 人）。`, { code: 403 });
    }
    set.add(user.id);
    const newMembers = Array.from(set);

    target.set('members', newMembers);
    target.set('memberCount', newMembers.length);
    await target.save();

    return { success: true, classCode, memberCount: newMembers.length, joined: true };
});

// 退出班级（最后一个人退出则删除）
AV.Cloud.define('leaveClass', async (request) => {
    const user = request.currentUser;
    const { classCode } = getParams(request);

    ensureLoggedIn(user);
    validateClassCode(classCode);

    const target = await getClassByCode(classCode);
    if (!target) {
        throw new AV.Cloud.Error('未找到该班级。', { code: 404 });
    }

    const members = target.get('members') || [];
    const newMembers = members.filter(id => id !== user.id);
    const newCount = newMembers.length;

    if (newCount === 0) {
        await target.destroy();
        return { success: true, classCode, deleted: true, memberCount: 0 };
    } else {
        target.set('members', newMembers);
        target.set('memberCount', newCount);
        await target.save();
        return { success: true, classCode, deleted: false, memberCount: newCount };
    }
});

// 查询班级信息（人数 + 冷却剩余）
AV.Cloud.define('getClassInfo', async (request) => {
    const user = request.currentUser;
    const { classCode } = getParams(request);

    ensureLoggedIn(user);
    validateClassCode(classCode);

    const target = await getClassByCode(classCode);
    if (!target) {
        throw new AV.Cloud.Error('未找到该班级。', { code: 404 });
    }

    const members = target.get('members') || [];
    const memberCount = target.get('memberCount') ?? members.length;
    const isMember = members.includes(user.id);
    const last = target.get('lastAlarmAt');

    const cooldownRemaining = (() => {
        if (!last) return 0;
        const diff = COOLDOWN_SECONDS - Math.floor((Date.now() - new Date(last).getTime()) / 1000);
        return diff > 0 ? diff : 0;
    })();

    return {
        success: true,
        classCode,
        memberCount,
        isMember,
        cooldownRemaining,
        lastAlarmAt: last ? new Date(last).toISOString() : null
    };
});

// 发送闹铃（班级级别 60s 冷却）
AV.Cloud.define('sendAlarm', async (request) => {
    const user = request.currentUser;
    const { classCode, alarmType } = getParams(request);

    ensureLoggedIn(user);
    validateClassCode(classCode);

    const targetClass = await getClassByCode(classCode);
    if (!targetClass) {
        throw new AV.Cloud.Error('未找到该班级。', { code: 404 });
    }

    const members = targetClass.get('members') || [];
    if (!members.includes(user.id)) {
        throw new AV.Cloud.Error('你不在该班级中，无法发送提醒。', { code: 403 });
    }

    const last = targetClass.get('lastAlarmAt');
    const now = Date.now();
    if (last) {
        const elapsed = (now - new Date(last).getTime()) / 1000;
        if (elapsed < COOLDOWN_SECONDS) {
            throw new AV.Cloud.Error(`发送过于频繁，请 ${Math.ceil(COOLDOWN_SECONDS - elapsed)} 秒后重试。`, { code: 429 });
        }
    }

    targetClass.set('lastAlarmAt', new Date(now));
    await targetClass.save();

    let alertMessage = '';
    if (alarmType === 'checkin') alertMessage = '班级有同学签到，速来！';
    else if (alarmType === 'rollcall') alertMessage = '老师开始点名，速来！';
    else alertMessage = '快来集合，有情况！';

    const recipientIds = members.filter(id => id !== user.id);
    if (recipientIds.length === 0) {
        return { success: true, message: '没有其他成员需要通知。', count: 0, memberCount: members.length };
    }

    const pushQuery = new AV.Query('_Installation');
    pushQuery.containedIn('user', recipientIds.map(id => AV.Object.createWithoutData('_User', id)));

    const pushData = { alert: alertMessage, sound: 'alarm.caf', badge: 'Increment' };

    try {
        await AV.Push.send({ query: pushQuery, data: pushData });
        return { success: true, count: recipientIds.length, memberCount: members.length };
    } catch (error) {
        console.error('推送发送失败:', error);
        throw new AV.Cloud.Error('推送发送失败，请稍后重试。', { code: 500 });
    }
});
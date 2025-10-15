const AV = require('leanengine');

const MAX_MEMBERS = 20;
const COOLDOWN_SECONDS = 60;

function getParams(request) {
    return (request && request.params) ? request.params : {};
}

// 兼容查询：优先查新表 Group(code)，若不存在则尝试旧表 Class(classCode)
// 若在旧表找到，会自动迁移到 Group 并删除旧记录
async function getGroupByCode(code) {
    // 先查 Group
    const gq = new AV.Query('Group');
    gq.equalTo('code', code);
    try {
        const found = await gq.first();
        if (found) return found;
    } catch (e) {
        // 101: 表或对象不存在，忽略继续走兼容逻辑
        if (!(e && (e.code === 101 || String(e.message || '').includes("doesn't exists")))) {
            throw e;
        }
    }

    // 再查旧表 Class（兼容）
    const cq = new AV.Query('Class');
    cq.equalTo('classCode', code);
    try {
        const legacy = await cq.first();
        if (!legacy) return null;

        const members = legacy.get('members') || [];
        const memberCount = legacy.get('memberCount') ?? members.length;
        const lastAlarmAt = legacy.get('lastAlarmAt') || new Date(0);

        // 迁移到 Group
        const obj = new AV.Object('Group');
        obj.set('code', code);
        obj.set('members', members);
        obj.set('memberCount', memberCount);
        obj.set('lastAlarmAt', lastAlarmAt);
        await obj.save();

        // 尝试删除旧记录（失败也不影响主流程）
        try { await legacy.destroy(); } catch (_) {}

        return obj;
    } catch (e) {
        // 表不存在或其他错误
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

function validateClassCode(code) {
    if (!code || typeof code !== 'string' || code.length !== 6) {
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

// 创建班级：使用 Group(code)
AV.Cloud.define('createClass', async (request) => {
    const user = request.currentUser;
    const { classCode } = getParams(request);

    ensureLoggedIn(user);
    validateClassCode(classCode);

    const existed = await getGroupByCode(classCode);
    if (existed) {
        throw new AV.Cloud.Error('班级码已存在，请换一个。', { code: 409 });
    }

    const obj = new AV.Object('Group');
    obj.set('code', classCode);
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

    const target = await getGroupByCode(classCode);
    if (!target) throw new AV.Cloud.Error('未找到该班级。', { code: 404 });

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

    const target = await getGroupByCode(classCode);
    if (!target) throw new AV.Cloud.Error('未找到该班级。', { code: 404 });

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

    const target = await getGroupByCode(classCode);
    if (!target) throw new AV.Cloud.Error('未找到该班级。', { code: 404 });

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
// 发送闹铃：正确筛选 Installation，默认走开发通道（不回滚 lastAlarmAt）
AV.Cloud.define('sendAlarm', async (request) => {
    const user = request.currentUser;
    const { classCode, alarmType } = request.params || {};
    const COOLDOWN_SECONDS = 60;

    if (!user) throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
    if (!classCode || typeof classCode !== 'string' || classCode.length !== 6) {
        throw new AV.Cloud.Error('班级码格式不正确。', { code: 400 });
    }

    // 找群组
    const gq = new AV.Query('Group');
    gq.equalTo('code', classCode);
    const group = await gq.first();
    if (!group) throw new AV.Cloud.Error('未找到该班级。', { code: 404 });

    // 成员校验
    const members = group.get('members') || [];
    if (!members.includes(user.id)) {
        throw new AV.Cloud.Error('你不在该班级中，无法发送提醒。', { code: 403 });
    }

    // 冷却检查
    const last = group.get('lastAlarmAt');
    const now = Date.now();
    if (last) {
        const elapsed = (now - new Date(last).getTime()) / 1000;
        if (elapsed < COOLDOWN_SECONDS) {
            throw new AV.Cloud.Error(`发送过于频繁，请 ${Math.ceil(COOLDOWN_SECONDS - elapsed)} 秒后重试。`, { code: 429 });
        }
    }

    // 更新冷却时间（按你的要求：不做回滚）
    group.set('lastAlarmAt', new Date(now));
    await group.save();

    // 目标用户：排除自己
    const recipientIds = members.filter(id => id !== user.id);
    if (recipientIds.length === 0) {
        return { success: true, count: 0, memberCount: members.length, message: '班级只有你一人，无需推送。' };
    }

    // 构造 Installation 查询：iOS、有 token、user 指向收件人
    const where = new AV.Query('_Installation');
    where.equalTo('deviceType', 'ios');
    where.exists('deviceToken');
    where.containedIn('user', recipientIds.map(id => AV.Object.createWithoutData('_User', id)));

    // 统计一下，便于你确认不是“0 目标”
    const targetCount = await where.count().catch(() => 0);
    console.log(`[sendAlarm] class=${classCode} sender=${user.id} targetInstallations=${targetCount}`);
    if (targetCount === 0) {
        return { success: true, count: 0, memberCount: members.length, message: '没有匹配的目标设备。' };
    }

    // 推送文案
    let alertMessage = '';
    if (alarmType === 'checkin') alertMessage = '班级有同学签到，速来！';
    else if (alarmType === 'rollcall') alertMessage = '老师开始点名，速来！';
    else alertMessage = '快来集合，有情况！';

    const data = { alert: alertMessage, sound: 'alarm.caf', badge: 'Increment' };

    // 环境：默认开发通道（Xcode 安装的包）。需要测生产时，到环境变量把 PUSH_ENV 改为 prod。
    const prod = process.env.PUSH_ENV || 'dev';

    // 注意：LeanCloud Node SDK 正确的参数名是 where（不是 query）
    await AV.Push.send({ where, data, prod });
    return { success: true, count: targetCount, memberCount: members.length };
});
const AV = require('leanengine');

const MAX_MEMBERS = 20;
const COOLDOWN_SECONDS = 60;

// 工具：兼容从 request.params 取参，或直接从 request 解构（兼容你之前的写法）
function getParams(request) {
    const params = request?.params || request || {};
    return params;
}

async function getClassByCode(classCode) {
    const q = new AV.Query('Class');
    q.equalTo('classCode', classCode);
    return q.first();
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

// 创建班级：把当前用户加入 members，memberCount=1
AV.Cloud.define('createClass', async (request) => {
    const { user } = request || {};
    const { classCode } = getParams(request);

    ensureLoggedIn(user);
    validateClassCode(classCode);

    // 唯一性检查
    const existed = await getClassByCode(classCode);
    if (existed) {
        throw new AV.Cloud.Error('班级码已存在，请换一个。', { code: 409 });
    }

    const obj = new AV.Object('Class');
    obj.set('classCode', classCode);
    obj.set('members', [user.id]);
    obj.set('memberCount', 1);
    // 可选：初始化冷却时间在过去，表示可立即发送
    obj.set('lastAlarmAt', new Date(0));

    await obj.save();
    return { success: true, classCode, memberCount: 1 };
});

// 加入班级：上限 20 人，去重加入
AV.Cloud.define('joinClass', async (request) => {
    const { user } = request || {};
    const { classCode } = getParams(request);

    ensureLoggedIn(user);
    validateClassCode(classCode);

    const target = await getClassByCode(classCode);
    if (!target) {
        throw new AV.Cloud.Error('未找到该班级。', { code: 404 });
    }

    const members = target.get('members') || [];
    const memberSet = new Set(members);

    if (!memberSet.has(user.id) && memberSet.size >= MAX_MEMBERS) {
        throw new AV.Cloud.Error(`班级人数已满（上限 ${MAX_MEMBERS} 人）。`, { code: 403 });
    }

    // 去重加入
    memberSet.add(user.id);
    const newMembers = Array.from(memberSet);

    target.set('members', newMembers);
    target.set('memberCount', newMembers.length);
    await target.save();

    return { success: true, classCode, memberCount: newMembers.length, joined: true };
});

// 退出班级：若成员数变 0，自动删除该班级
AV.Cloud.define('leaveClass', async (request) => {
    const { user } = request || {};
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
        // 最后一个人退出：删除班级
        await target.destroy();
        return { success: true, classCode, deleted: true, memberCount: 0 };
    } else {
        target.set('members', newMembers);
        target.set('memberCount', newCount);
        await target.save();
        return { success: true, classCode, deleted: false, memberCount: newCount };
    }
});

// 查询班级信息：返回当前人数、是否成员
AV.Cloud.define('getClassInfo', async (request) => {
    const { user } = request || {};
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

    return {
        success: true,
        classCode,
        memberCount,
        isMember,
        // 可选：返回冷却剩余秒数
        cooldownRemaining: (() => {
            const last = target.get('lastAlarmAt');
            if (!last) return 0;
            const diff = COOLDOWN_SECONDS - Math.floor((Date.now() - new Date(last).getTime()) / 1000);
            return diff > 0 ? diff : 0;
        })()
    };
});

/**
 * 发送闹铃通知（每个班级每分钟限一次）
 * @param {string} classCode - 6位的班级码
 * @param {string} alarmType - 'checkin' | 'rollcall' | 其他
 */
AV.Cloud.define('sendAlarm', async (request) => {
    const { user } = request || {};
    const { classCode, alarmType } = getParams(request);

    ensureLoggedIn(user);
    validateClassCode(classCode);

    // 1) 查班级
    const targetClass = await getClassByCode(classCode);
    if (!targetClass) {
        throw new AV.Cloud.Error('未找到该班级。', { code: 404 });
    }

    // 2) 校验成员
    const members = targetClass.get('members') || [];
    if (!members.includes(user.id)) {
        throw new AV.Cloud.Error('你不在该班级中，无法发送提醒。', { code: 403 });
    }

    // 3) 限频：每个班级每分钟最多一次
    const last = targetClass.get('lastAlarmAt');
    const now = Date.now();
    if (last) {
        const elapsed = (now - new Date(last).getTime()) / 1000;
        if (elapsed < COOLDOWN_SECONDS) {
            throw new AV.Cloud.Error(`发送过于频繁，请 ${Math.ceil(COOLDOWN_SECONDS - elapsed)} 秒后重试。`, { code: 429 });
        }
    }

    // 先更新 lastAlarmAt，尽量减少并发下的重复发送（仍非强事务，免费版够用）
    targetClass.set('lastAlarmAt', new Date(now));
    await targetClass.save();

    // 4) 组装消息
    let alertMessage = '';
    if (alarmType === 'checkin') {
        alertMessage = '班级有同学签到，速来！';
    } else if (alarmType === 'rollcall') {
        alertMessage = '老师开始点名，速来！';
    } else {
        alertMessage = '快来集合，有情况！';
    }

    // 5) 推送目标：所有成员安装，排除发送者
    const recipientIds = members.filter(id => id !== user.id);
    if (recipientIds.length === 0) {
        return { success: true, message: '没有其他成员需要通知。', count: 0 };
    }

    const pushQuery = new AV.Query('_Installation');
    // _Installation.user 是 Pointer<_User>
    pushQuery.containedIn('user', recipientIds.map(id => AV.Object.createWithoutData('_User', id)));

    // 6) 发送推送
    const pushData = {
        alert: alertMessage,
        sound: 'alarm.caf',
        badge: 'Increment'
    };

    try {
        await AV.Push.send({
            query: pushQuery,
            data: pushData
        });
        return { success: true, count: recipientIds.length, memberCount: members.length };
    } catch (error) {
        console.error('推送发送失败:', error);
        throw new AV.Cloud.Error('推送发送失败，请稍后重试。', { code: 500 });
    }
});

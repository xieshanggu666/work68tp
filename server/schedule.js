// 候选人 ↔ 面试官双向预约沟通模块
// - 可用时段：候选人和面试官各自维护 schedule_slots，系统提供双方时段交集
// - 双向确认：预约单 proposed → 双方 ack 后 confirmed（确认后同事务生成正式 interviews 记录）
// - 改期：任一方发起 reschedule_requested，另一方同意（移动时段+更新面试时间）或拒绝（维持原约）
// - 提醒：sweepReminders 在状态拉取时扫描，24h/2h 各提醒一次；超时未记录出席挂出 overdue 标记
// - 缺席：出席完成 / 候选人缺席（联动流程淘汰，复用 moveStage 状态机）/ 面试官缺席（可重新安排）
// 全程 appointment_messages 只追加留痕，并按角色投递 notifications（候选人侧提醒由招聘负责人代收转达）
import express from 'express'
import db, { ts } from './db.js'
import { auditPassive } from './crisis.js'

export const router = express.Router()

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const parseJSON = (s, d) => { try { return JSON.parse(s || '') ?? d } catch { return d } }
const httpError = (status, code, msg) => Object.assign(new Error(msg), { status, code })
const badRequest = (m, c = 'invalid') => { throw httpError(400, c, m) }
const conflict = (m, c = 'conflict') => { throw httpError(409, c, m) }
const forbidden = (m, c = 'forbidden') => { throw httpError(403, c, m) }
const wrap = fn => (req, res, next) => { try { return fn(req, res, next) } catch (e) { next(e) } }

function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export const ROLE_LABEL = { recruiter: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理' }
export const APPOINTMENT_STATUS_LABEL = {
  proposed: '待双向确认', reschedule_requested: '改期协商中', confirmed: '已确认',
  declined: '婉拒待重新提议', cancelled: '已取消', completed: '已出席',
  candidate_noshow: '候选人缺席', interviewer_noshow: '面试官缺席'
}
export const MODE_LABEL = { onsite: '现场', video: '视频', phone: '电话' }
const OPEN_STATUSES = ['proposed', 'reschedule_requested', 'confirmed']
// 出席/缺席记录只允许在这些状态下登记
const ATTEND_FROM = ['confirmed', 'reschedule_requested']

function currentUser(req) {
  const id = String(req.headers['x-user-id'] || '')
  const u = id ? db.prepare('SELECT * FROM users WHERE id=?').get(id) : null
  return u || db.prepare("SELECT * FROM users WHERE role='recruiter' ORDER BY id LIMIT 1").get()
}

// 主流程注入的业务能力（与 index.js 共用同一条状态机，避免口径分叉）
let core = null
export function bindScheduleCore(c) { core = c }

function notify(recipientRole, type, title, body, applicationId = 0) {
  db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,task_id,application_id,is_read,created_at)
              VALUES(?,?,?,?,0,?,0,?)`).run(recipientRole, type, title, body, num(applicationId), ts())
}

// ---------------- 时间工具 ----------------
const pad = n => String(n).padStart(2, '0')
export function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
export function timeStr(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x }
function isoAt(date, hm) { return `${date}T${hm}:00` }
function parseStart(startAt) {
  // 兼容 YYYY-MM-DDTHH:mm 与带秒/带时区的形式（演示环境无时区转换）
  const t = new Date(String(startAt))
  if (isNaN(t.getTime())) badRequest('面试时间格式不正确', 'time_invalid')
  return t
}
function minuteOf(hm) { const [h, m] = String(hm).split(':').map(Number); return (h || 0) * 60 + (m || 0) }
function fmtHM(s) { return String(s || '').slice(11, 16) }
export const fmtStart = s => s ? String(s).replace('T', ' ').slice(0, 16) : ''
function durationBetween(startAt, endAt) {
  const e = String(endAt) ? parseStart(endAt) : null
  const s = parseStart(startAt)
  if (!e) return 60
  return Math.max(15, Math.round((e - s) / 60000))
}

// ---------------- 可用时段 ----------------
// 命中某预约时间区间的可用时段（按同日期 + 分钟区间相交判断）
function slotCovers(slot, date, startHM, endHM) {
  if (slot.date !== date) return false
  return minuteOf(slot.start_time) <= minuteOf(startHM) && minuteOf(slot.end_time) >= minuteOf(endHM)
}
function findSlot(ownerType, { userId = '', candidateId = 0 }, date, startHM, endHM) {
  const rows = db.prepare(`SELECT * FROM schedule_slots
                           WHERE owner_type=? AND user_id=? AND candidate_id=? AND date=? AND status='available'
                           ORDER BY id`).all(ownerType, userId, num(candidateId), date)
  return rows.find(s => slotCovers(s, date, startHM, endHM)) || null
}
// 同面试官/同候选人在该时段已有占用（时段冲突双重校验，防止绕过锁时重复约）
function busyAppointment(ownerType, { userId = '', candidateId = 0 }, startAt, endAt, ignoreId = 0) {
  const s = parseStart(startAt)
  return db.prepare(`SELECT * FROM appointments
                     WHERE status IN ('proposed','reschedule_requested','confirmed')
                       AND id!=?
                       AND start_at < ? AND end_at > ?
                       AND ${ownerType === 'interviewer' ? 'interviewer_user_id=?' : 'application_id IN (SELECT id FROM applications WHERE candidate_id=?)'}`)
    .get(num(ignoreId), endAt, startAt, ownerType === 'interviewer' ? userId : num(candidateId)) || null
}
function bookSlot(slot, appointmentId) {
  db.prepare('UPDATE schedule_slots SET status=?, booked_appointment_id=? WHERE id=?')
    .run('booked', appointmentId, slot.id)
}
function releaseSlots(appointmentId) {
  db.prepare("UPDATE schedule_slots SET status='available', booked_appointment_id=0 WHERE booked_appointment_id=?")
    .run(appointmentId)
}

// 计算某候选人与某面试官在 [fromDays, toDays] 内的时段交集
function overlapSlots(applicationId, interviewerUserId, fromDays = 0, toDays = 14) {
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(num(applicationId))
  if (!a) return []
  const base = new Date()
  const out = []
  for (let i = fromDays; i <= toDays; i++) {
    const d = dateStr(addDays(base, i))
    const cand = db.prepare(`SELECT * FROM schedule_slots WHERE owner_type='candidate' AND candidate_id=? AND date=? AND status!='blocked' ORDER BY start_time`)
      .all(a.candidate_id, d)
    const iv = db.prepare(`SELECT * FROM schedule_slots WHERE owner_type='interviewer' AND user_id=? AND date=? AND status!='blocked' ORDER BY start_time`)
      .all(String(interviewerUserId), d)
    cand.forEach(cs => {
      iv.forEach(is => {
        if (cs.mode !== is.mode) return // 仅推荐相同面试方式（现场/视频/电话）的交集
        const lo = Math.max(minuteOf(cs.start_time), minuteOf(is.start_time))
        const hi = Math.min(minuteOf(cs.end_time), minuteOf(is.end_time))
        if (hi - lo >= 30) {
          const toHM = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
          out.push({
            date: d, start_time: toHM(lo), end_time: toHM(hi), mode: cs.mode,
            candidate_slot_id: cs.id, interviewer_slot_id: is.id,
            candidate_slot_status: cs.status, interviewer_slot_status: is.status
          })
        }
      })
    })
  }
  return out
}

// ---------------- 预约单状态机 ----------------
function getAppointment(id) {
  return db.prepare('SELECT * FROM appointments WHERE id=?').get(num(id)) || null
}
function loadMessages(appointmentId) {
  return db.prepare('SELECT * FROM appointment_messages WHERE appointment_id=? ORDER BY id ASC').all(num(appointmentId))
}
function addMessage(apt, { kind, side = '', sender, content = '', payload = {} }) {
  db.prepare(`INSERT INTO appointment_messages(appointment_id,sender_type,sender_id,sender_name,kind,side,content,payload,created)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(apt.id, sender?.type || 'system', sender?.id || '', sender?.name || '', kind, side, content, JSON.stringify(payload || {}), ts())
}
function refreshUpdated(apt) {
  db.prepare('UPDATE appointments SET updated=? WHERE id=?').run(ts(), apt.id)
}

// 双方确认后生成正式 interviews 记录（复用主流程创建函数，与「添加下一轮面试」完全同口径）
function ensureInterview(apt, a) {
  if (apt.interview_id) {
    // 改期确认：同步正式面试记录的时间与地点
    db.prepare('UPDATE interviews SET time=?, interviewer=? WHERE id=?')
      .run(fmtStart(apt.start_at), apt.interviewer_name, apt.interview_id)
    return apt.interview_id
  }
  const id = core.createInterview(a.id, {
    interviewer: apt.interviewer_name,
    time: fmtStart(apt.start_at),
    round: apt.round
  })
  db.prepare('UPDATE appointments SET interview_id=? WHERE id=?').run(id, apt.id)
  return id
}

// 双方均已接受：置 confirmed、锁定时段、生成面试记录并通知
function confirmIfBothAccepted(apt, a) {
  if (apt.candidate_ack !== 'accepted' || apt.interviewer_ack !== 'accepted') return false
  const wasConfirmed = apt.status === 'confirmed'
  apt.status = 'confirmed'
  db.prepare('UPDATE appointments SET status=?, version=version+1, updated=? WHERE id=?').run('confirmed', ts(), apt.id)
  ensureInterview(apt, a)
  addMessage(apt, {
    kind: 'confirm',
    sender: { type: 'system', name: '系统' },
    content: `双方已确认面试预约：${apt.round} ${fmtStart(apt.start_at)}（${MODE_LABEL[apt.mode] || apt.mode}），正式面试记录已生成。`
  })
  if (!wasConfirmed) {
    notify('recruiter', 'schedule_confirmed', '面试预约已双方确认',
      `「${a.id}」${apt.round} 已确认：${fmtStart(apt.start_at)}，候选人与面试官均已同意。`, a.id)
    notify('interviewer', 'schedule_confirmed', '面试预约已双方确认',
      `您的${apt.round}已确认：${fmtStart(apt.start_at)}，请按时参加。`, a.id)
  }
  return true
}

// 提议预约（招聘负责人代候选人沟通 / 面试官均可发起）
function proposeAppointment({ a, interviewer, round, startAt, endAt, durationMin = 60, location = '', mode = 'onsite', actor, actorSide, onBehalfCandidate = false, note = '' }) {
  if (['rejected', 'hired'].includes(a.stage)) conflict('该候选人流程已终态，不能再预约面试', 'terminal_locked')
  const date = String(startAt).slice(0, 10)
  const startHM = fmtHM(startAt)
  const endHM = endAt ? fmtHM(endAt) : (() => {
    const d = parseStart(startAt); d.setMinutes(d.getMinutes() + num(durationMin, 60)); return timeStr(d)
  })()
  if (minuteOf(endHM) <= minuteOf(startHM)) badRequest('结束时间需晚于开始时间', 'time_invalid')
  if (busyAppointment('interviewer', { userId: interviewer.id }, startAt, endAt ? endAt : isoAt(date, endHM))) {
    conflict('该面试官此时段已有其他面试安排，请选择双方空闲时段', 'interviewer_busy')
  }
  const candBusy = busyAppointment('candidate', { candidateId: a.candidate_id }, startAt, endAt ? endAt : isoAt(date, endHM))
  if (candBusy) conflict('候选人此时段已有其他面试安排', 'candidate_busy')

  // 面试官发起时本人侧自动接受；招聘负责人仅在显式勾选「候选人已电话确认」时代候选人接受，
  // 否则双方均待确认（候选人由招聘负责人转达后再在详情中代确认）
  const actorIsInterviewer = actorSide === 'interviewer'
  const candidateAccepted = actorIsInterviewer ? false : !!onBehalfCandidate
  const stamp = ts()
  const r = db.prepare(`INSERT INTO appointments
    (application_id,interviewer_user_id,interviewer_name,round,proposed_by,proposed_by_name,
     start_at,end_at,duration_min,location,mode,status,candidate_ack,interviewer_ack,
     candidate_ack_at,interviewer_ack_at,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?, 'proposed', ?, ?, ?, ?, ?, ?)`)
    .run(a.id, interviewer.id, interviewer.name, round || '初试', actor.id, actor.name,
      startAt, endAt ? endAt : isoAt(date, endHM), durationBetween(startAt, endAt ? endAt : isoAt(date, endHM)),
      location, mode,
      candidateAccepted ? 'accepted' : 'pending', actorIsInterviewer ? 'accepted' : 'pending',
      candidateAccepted ? stamp : '', actorIsInterviewer ? stamp : '', stamp, stamp)
  const aptId = Number(r.lastInsertRowid)

  // 自动锁定双方命中的可用时段（无匹配时段也允许提议，交集仅作推荐）
  const ivSlot = findSlot('interviewer', { userId: interviewer.id }, date, startHM, endHM)
  if (ivSlot) bookSlot(ivSlot, aptId)
  const candSlot = findSlot('candidate', { candidateId: a.candidate_id }, date, startHM, endHM)
  if (candSlot) bookSlot(candSlot, aptId)

  const apt = getAppointment(aptId)
  addMessage(apt, {
    kind: 'propose', side: actorSide || 'recruiter',
    sender: { type: actorIsInterviewer ? 'interviewer' : 'recruiter', id: actor.id, name: actor.name },
    content: note || `${actor.name} 提议面试时间：${fmtStart(startAt)}（${MODE_LABEL[mode] || mode}${location ? ' · ' + location : ''}），等待${actorIsInterviewer ? '候选人确认' : '面试官确认'}。`,
    payload: { start_at: startAt, end_at: apt.end_at, mode, location, round: apt.round }
  })
  if (actorIsInterviewer) {
    notify('recruiter', 'schedule_proposed', '面试官提议了面试时间，待候选人确认',
      `${interviewer.name} 为「应聘 #${a.id}」提议 ${fmtStart(startAt)}，请与候选人确认。`, a.id)
  } else {
    notify('interviewer', 'schedule_proposed', '新的面试预约待您确认',
      `${actor.name} 提议您于 ${fmtStart(startAt)} 进行「${apt.round}」，请确认是否可参加。`, a.id)
    // 候选人侧没有系统账号：未勾选已确认时，提示招聘负责人转达后代操作
    if (!candidateAccepted) {
      notify('recruiter', 'schedule_candidate_pending', '请向候选人转达面试预约并代为确认',
        `「应聘 #${a.id}」提议时间 ${fmtStart(startAt)}，面试官确认后还需候选人（由招聘负责人转达）确认。`, a.id)
    }
  }
  confirmIfBothAccepted(getAppointment(aptId), a)
  return aptId
}

// 确认/婉拒（side 由接口按身份/代操作参数固定，防止越权确认对方）
function ackAppointment(apt, { side, accept, actor, note = '' }) {
  if (apt.status !== 'proposed') {
    if (apt.status === 'declined') conflict('该预约已被婉拒，请重新提议面试时间', 'status_declined')
    conflict(`当前状态「${APPOINTMENT_STATUS_LABEL[apt.status]}」不支持确认/婉拒`, 'status_not_ackable')
  }
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(apt.application_id)
  if (!a) badRequest('关联应聘记录不存在', 'app_missing')
  const field = side === 'interviewer' ? 'interviewer_ack' : 'candidate_ack'
  const atField = side === 'interviewer' ? 'interviewer_ack_at' : 'candidate_ack_at'
  const nextAck = accept ? 'accepted' : 'declined'
  const prevAck = apt[field]
  // 改期协商中的确认由 reschedule 接口处理（需要移动时段），这里仅处理首次提议/婉拒后的重新确认
  if (apt.status === 'reschedule_requested') conflict('改期协商中请使用「同意/拒绝改期」', 'use_reschedule')

  db.prepare(`UPDATE appointments SET ${field}=?, ${atField}=?, version=version+1, updated=? WHERE id=?`)
    .run(nextAck, accept ? ts() : '', ts(), apt.id)
  apt[field] = nextAck

  const sideName = side === 'interviewer' ? '面试官' : '候选人'
  if (accept) {
    addMessage(apt, {
      kind: 'accept', side,
      sender: { type: side === 'interviewer' ? 'interviewer' : 'recruiter', id: actor.id, name: actor.name },
      content: note || `${actor.name} 已代表${side === 'interviewer' ? '面试官' : '候选人'}接受该面试时间。`
    })
    const otherAck = side === 'interviewer' ? apt.candidate_ack : apt.interviewer_ack
    if (otherAck === 'accepted') {
      confirmIfBothAccepted(getAppointment(apt.id), a)
    } else {
      notify(side === 'interviewer' ? 'recruiter' : 'interviewer', 'schedule_ack',
        `${sideName}已确认面试时间`, `${sideName}已接受 ${fmtStart(apt.start_at)}，等待${side === 'interviewer' ? '候选人' : '面试官'}确认。`, a.id)
    }
  } else {
    // 婉拒：释放锁定时段，单回到 declined，双方可直接重新提议（历史消息保留）
    releaseSlots(apt.id)
    db.prepare("UPDATE appointments SET status='declined', version=version+1, updated=? WHERE id=?").run(ts(), apt.id)
    apt.status = 'declined'
    addMessage(apt, {
      kind: 'decline', side,
      sender: { type: side === 'interviewer' ? 'interviewer' : 'recruiter', id: actor.id, name: actor.name },
      content: note || `${actor.name} 婉拒了该面试时间，请重新协商。`
    })
    notify(side === 'interviewer' ? 'recruiter' : 'interviewer', 'schedule_declined',
      `${sideName}婉拒了面试时间`, `${sideName}无法参加 ${fmtStart(apt.start_at)}：${note || '请重新提议时间'}。`, a.id)
  }
  return apt
}

// 改期：仅已确认（confirmed）的预约可申请；协商通过后移动时段并同步正式面试记录
function requestReschedule(apt, { actor, actorSide, startAt, endAt, durationMin = 60, location, mode, note = '' }) {
  if (apt.status !== 'confirmed' && apt.status !== 'reschedule_requested') {
    conflict('仅已双方确认的预约可以申请改期；未确认的预约请婉拒后重新提议', 'status_no_reschedule')
  }
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(apt.application_id)
  if (!a) badRequest('关联应聘记录不存在', 'app_missing')
  const date = String(startAt).slice(0, 10)
  const startHM = fmtHM(startAt)
  const endHM = endAt ? fmtHM(endAt) : (() => {
    const d = parseStart(startAt); d.setMinutes(d.getMinutes() + num(durationMin, 60)); return timeStr(d)
  })()
  const finalEnd = endAt ? endAt : isoAt(date, endHM)
  if (busyAppointment('interviewer', { userId: apt.interviewer_user_id }, startAt, finalEnd, apt.id)) {
    conflict('面试官在新时段已有其他面试安排', 'interviewer_busy')
  }
  if (busyAppointment('candidate', { candidateId: a.candidate_id }, startAt, finalEnd, apt.id)) {
    conflict('候选人在新时段已有其他面试安排', 'candidate_busy')
  }

  const wasRescheduling = apt.status === 'reschedule_requested'
  db.prepare(`UPDATE appointments SET status='reschedule_requested', reschedule_count=reschedule_count+1, version=version+1, updated=? WHERE id=?`)
    .run(ts(), apt.id)
  apt.status = 'reschedule_requested'
  addMessage(apt, {
    kind: 'reschedule_request', side: actorSide,
    sender: { type: actorSide === 'interviewer' ? 'interviewer' : 'recruiter', id: actor.id, name: actor.name },
    content: note || `${actor.name} 申请改期：${fmtStart(apt.start_at)} → ${fmtStart(startAt)}（${MODE_LABEL[mode || apt.mode] || mode || apt.mode}），等待${actorSide === 'interviewer' ? '候选人' : '面试官'}回应。`,
    payload: {
      start_at: startAt, end_at: finalEnd,
      mode: mode || apt.mode, location: location !== undefined ? location : apt.location,
      prev_start_at: apt.start_at, counter: wasRescheduling ? 1 : 0
    }
  })
  notify(actorSide === 'interviewer' ? 'recruiter' : 'interviewer', 'schedule_reschedule',
    '收到面试改期请求',
    `${actor.name} 申请将「${apt.round}」改至 ${fmtStart(startAt)}（原时间 ${fmtStart(apt.start_at)}），请回应。`, a.id)
  return apt
}

function respondReschedule(apt, { accept, actor, side, note = '' }) {
  if (apt.status !== 'reschedule_requested') conflict('当前没有待回应的改期请求', 'no_reschedule')
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(apt.application_id)
  if (!a) badRequest('关联应聘记录不存在', 'app_missing')
  const reqMsg = db.prepare(`SELECT * FROM appointment_messages WHERE appointment_id=? AND kind='reschedule_request' ORDER BY id DESC LIMIT 1`)
    .get(apt.id)
  const req = parseJSON(reqMsg?.payload, {})

  if (accept) {
    // 面试官冲突在请求发起时已校验；此处再兜底校验一次，防止请求期间时段被占
    const ivBusy = busyAppointment('interviewer', { userId: apt.interviewer_user_id }, req.start_at, req.end_at || apt.end_at, apt.id)
    if (ivBusy) conflict('面试官在新时段已被占用，请改约其他时间', 'interviewer_busy')
    const candBusy = busyAppointment('candidate', { candidateId: a.candidate_id }, req.start_at, req.end_at || apt.end_at, apt.id)
    if (candBusy) conflict('候选人在新时段已被占用，请改约其他时间', 'candidate_busy')
    // 移动锁定时段：释放旧时段，锁定新时段（若在可用时段表中存在）
    releaseSlots(apt.id)
    const date = String(req.start_at).slice(0, 10)
    const ivSlot = findSlot('interviewer', { userId: apt.interviewer_user_id }, date, fmtHM(req.start_at), fmtHM(req.end_at))
    if (ivSlot) bookSlot(ivSlot, apt.id)
    const candSlot = findSlot('candidate', { candidateId: a.candidate_id }, date, fmtHM(req.start_at), fmtHM(req.end_at))
    if (candSlot) bookSlot(candSlot, apt.id)

    const oldStart = apt.start_at
    db.prepare(`UPDATE appointments
      SET status='confirmed', start_at=?, end_at=?, mode=?, location=?, version=version+1, updated=? WHERE id=?`)
      .run(req.start_at, req.end_at || apt.end_at, req.mode || apt.mode, req.location !== undefined ? req.location : apt.location, ts(), apt.id)
    apt.status = 'confirmed'
    apt.start_at = req.start_at
    ensureInterview(apt, a)
    addMessage(apt, {
      kind: 'reschedule_accept', side,
      sender: { type: side === 'interviewer' ? 'interviewer' : 'recruiter', id: actor.id, name: actor.name },
      content: note || `${actor.name} 同意改期：${fmtStart(oldStart)} → ${fmtStart(req.start_at)}，面试记录已同步更新。`
    })
    notify(side === 'interviewer' ? 'recruiter' : 'interviewer', 'schedule_reschedule_done',
      '改期已确认', `「${apt.round}」改期已确认，新时间：${fmtStart(req.start_at)}（原 ${fmtStart(oldStart)}）。`, a.id)
    // 旧的提醒标记随新时间重置，保证新时间点还能再收到 24h/2h 提醒
    db.prepare("UPDATE appointments SET remind_24_at='', remind_2h_at='', overdue_at='' WHERE id=?").run(apt.id)
  } else {
    db.prepare("UPDATE appointments SET status='confirmed', version=version+1, updated=? WHERE id=?").run(ts(), apt.id)
    apt.status = 'confirmed'
    addMessage(apt, {
      kind: 'reschedule_decline', side,
      sender: { type: side === 'interviewer' ? 'interviewer' : 'recruiter', id: actor.id, name: actor.name },
      content: note || `${actor.name} 拒绝改期，维持原约定时间 ${fmtStart(apt.start_at)}。`
    })
    notify(side === 'interviewer' ? 'recruiter' : 'interviewer', 'schedule_reschedule_rejected',
      '改期被拒绝，维持原约', `对方未能同意改期：${note || '维持原时间 ' + fmtStart(apt.start_at)}。`, a.id)
  }
  return apt
}

function cancelAppointment(apt, { actor, side, note = '' }) {
  if (!OPEN_STATUSES.includes(apt.status) && apt.status !== 'declined') {
    conflict(`当前状态「${APPOINTMENT_STATUS_LABEL[apt.status]}」不能取消`, 'status_no_cancel')
  }
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(apt.application_id)
  releaseSlots(apt.id)
  db.prepare("UPDATE appointments SET status='cancelled', version=version+1, updated=? WHERE id=?").run(ts(), apt.id)
  apt.status = 'cancelled'
  addMessage(apt, {
    kind: 'cancel', side,
    sender: { type: side === 'interviewer' ? 'interviewer' : 'recruiter', id: actor.id, name: actor.name },
    content: note || `${actor.name} 取消了该面试预约。`
  })
  if (a) {
    notify('recruiter', 'schedule_cancelled', '面试预约已取消',
      `「应聘 #${a.id}」${apt.round}（${fmtStart(apt.start_at)}）已取消：${note || '协商重新安排'}。`, a.id)
    notify('interviewer', 'schedule_cancelled', '面试预约已取消',
      `您的${apt.round}（${fmtStart(apt.start_at)}）已被取消：${note || '协商重新安排'}。`, a.id)
  }
  return apt
}

// 出席记录：attended 出席 / candidate_noshow 候选人缺席（联动淘汰）/ interviewer_noshow 面试官缺席（可重新安排）
function markAttendance(apt, { result, actor, note = '' }) {
  if (!ATTEND_FROM.includes(apt.status)) {
    conflict(`当前状态「${APPOINTMENT_STATUS_LABEL[apt.status]}」不允许记录出席情况`, 'status_no_attend')
  }
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(apt.application_id)
  if (!a) badRequest('关联应聘记录不存在', 'app_missing')
  const stamp = ts()

  if (result === 'attended') {
    db.prepare("UPDATE appointments SET status='completed', attend_marked_by=?, attend_marked_at=?, version=version+1, updated=? WHERE id=?")
      .run(actor.name, stamp, stamp, apt.id)
    apt.status = 'completed'
    releaseSlots(apt.id)
    addMessage(apt, {
      kind: 'attend', sender: { type: 'recruiter', id: actor.id, name: actor.name },
      content: note || `${actor.name} 记录：双方已准时出席，面试正常进行。`
    })
    notify('interviewer', 'schedule_attended', '面试已完成出席登记',
      `「${apt.round}」${fmtStart(apt.start_at)} 已登记出席，请及时在面试管理中填写评价与结论。`, a.id)
  } else if (result === 'candidate_noshow') {
    // 候选人缺席：预约终结，释放时段；复用主流程淘汰状态机（写 reject 阶段事件，待回应 Offer 联动撤回）
    core.rejectForNoShow(a, { operator: actor.name, reason: note || '候选人面试缺席（未到场且未提前改期）' })
    db.prepare("UPDATE appointments SET status='candidate_noshow', attend_marked_by=?, attend_marked_at=?, version=version+1, updated=? WHERE id=?")
      .run(actor.name, stamp, stamp, apt.id)
    apt.status = 'candidate_noshow'
    releaseSlots(apt.id)
    addMessage(apt, {
      kind: 'noshow', side: 'candidate',
      sender: { type: 'recruiter', id: actor.id, name: actor.name },
      content: note || `候选人未出席 ${fmtStart(apt.start_at)} 的面试，且未提前申请改期；流程已按缺席淘汰处理，可在招聘流程中异常回退复活。`
    })
    notify('interviewer', 'schedule_noshow', '候选人面试缺席',
      `「应聘 #${a.id}」候选人未出席 ${fmtStart(apt.start_at)} 的${apt.round}，应聘已按缺席淘汰。`, a.id)
    notify('recruiter', 'schedule_noshow', '候选人面试缺席',
      `「应聘 #${a.id}」候选人缺席 ${fmtStart(apt.start_at)} 的${apt.round}，流程已联动淘汰（可异常回退复活）。`, a.id)
  } else if (result === 'interviewer_noshow') {
    // 面试官缺席：预约终结但流程不动，招聘负责人可基于该应聘重新发起预约
    db.prepare("UPDATE appointments SET status='interviewer_noshow', attend_marked_by=?, attend_marked_at=?, version=version+1, updated=? WHERE id=?")
      .run(actor.name, stamp, stamp, apt.id)
    apt.status = 'interviewer_noshow'
    releaseSlots(apt.id)
    addMessage(apt, {
      kind: 'noshow', side: 'interviewer',
      sender: { type: 'recruiter', id: actor.id, name: actor.name },
      content: note || `面试官未出席 ${fmtStart(apt.start_at)} 的面试，请向候选人致歉并尽快重新安排。`
    })
    notify('interviewer', 'schedule_noshow', '面试官缺席已登记',
      `您缺席了 ${fmtStart(apt.start_at)} 的「${apt.round}」，请关注后续重新安排。`, a.id)
    notify('recruiter', 'schedule_noshow', '面试官缺席，待重新安排',
      `「应聘 #${a.id}」${apt.round}面试官缺席（${fmtStart(apt.start_at)}），请与候选人重新协商时间。`, a.id)
  } else {
    badRequest('出席结果仅支持 attended/candidate_noshow/interviewer_noshow', 'attend_result_invalid')
  }
  return apt
}

// ---------------- 提醒扫描（状态拉取时同步执行） ----------------
// 24h / 2h 各提醒一次；超过结束时间 15 分钟仍未登记出席的 confirmed 预约挂出 overdue 标记并通知
export function sweepReminders() {
  const nowMs = Date.now()
  return tx(() => {
    const apts = db.prepare(`SELECT * FROM appointments WHERE status IN ('proposed','reschedule_requested','confirmed')`).all()
    let count = 0
    apts.forEach(apt => {
      const a = db.prepare('SELECT id FROM applications WHERE id=?').get(apt.application_id)
      const start = parseStart(apt.start_at)
      const end = apt.end_at ? parseStart(apt.end_at) : new Date(start.getTime() + num(apt.duration_min, 60) * 60000)
      const mins = (start - nowMs) / 60000
      let changed = false
      const stamp = ts()

      if (apt.status === 'confirmed') {
        if (!apt.remind_24_at && mins <= 24 * 60 && mins > 0) {
          db.prepare("UPDATE appointments SET remind_24_at=? WHERE id=?").run(stamp, apt.id)
          notify('interviewer', 'schedule_remind', '【24小时提醒】明日面试',
            `您的「${apt.round}」将于 ${fmtStart(apt.start_at)} 开始（${MODE_LABEL[apt.mode] || apt.mode}${apt.location ? ' · ' + apt.location : ''}），请提前准备。`, apt.application_id)
          notify('recruiter', 'schedule_remind', '【24小时提醒】请提醒候选人参加面试',
            `「应聘 #${apt.application_id}」面试将于 ${fmtStart(apt.start_at)} 开始，请提醒候选人准时参加。`, apt.application_id)
          addMessage(apt, { kind: 'remind', content: '系统已在面试前 24 小时向面试官发出提醒，并提示招聘负责人转达候选人。' })
          changed = true; count++
        }
        if (!apt.remind_2h_at && apt.remind_24_at && mins <= 120 && mins > 0) {
          db.prepare("UPDATE appointments SET remind_2h_at=? WHERE id=?").run(stamp, apt.id)
          notify('interviewer', 'schedule_remind', '【2小时提醒】面试即将开始',
            `「${apt.round}」将于 ${fmtStart(apt.start_at)} 开始，请准时进入${MODE_LABEL[apt.mode] || apt.mode}面试。`, apt.application_id)
          notify('recruiter', 'schedule_remind', '【2小时提醒】请再次提醒候选人',
            `「应聘 #${apt.application_id}」面试将于 ${fmtStart(apt.start_at)} 开始，请再次提醒候选人。`, apt.application_id)
          addMessage(apt, { kind: 'remind', content: '系统已在面试前 2 小时再次提醒双方。' })
          changed = true; count++
        }
      }
      if (!apt.overdue_at && apt.status === 'confirmed' && nowMs > end.getTime() + 15 * 60000) {
        db.prepare("UPDATE appointments SET overdue_at=? WHERE id=?").run(stamp, apt.id)
        notify('recruiter', 'schedule_overdue', '面试已结束，请记录出席情况',
          `「应聘 #${apt.application_id}」${apt.round}（${fmtStart(apt.start_at)}）已超时未登记，请确认出席 / 候选人缺席 / 面试官缺席。`, apt.application_id)
        changed = true; count++
      }
      if (changed) db.prepare('UPDATE appointments SET updated=? WHERE id=?').run(stamp, apt.id)
    })
    return count
  })
}

// ---------------- 状态汇总 ----------------
export function getScheduleState() {
  const slots = db.prepare('SELECT * FROM schedule_slots ORDER BY date, start_time').all()
    .map(s => ({ ...s, candidate_id: num(s.candidate_id), booked_appointment_id: num(s.booked_appointment_id) }))
  const apps = db.prepare('SELECT id,candidate_id,position_id,stage FROM applications').all()
  const cands = db.prepare('SELECT id,name FROM candidates').all()
  const poss = db.prepare('SELECT id,name FROM positions').all()
  const users = db.prepare("SELECT id,name,role FROM users WHERE role='interviewer'").all()
  const candName = id => cands.find(c => c.id === num(id))?.name || ''
  const posName = id => poss.find(p => p.id === num(id))?.name || ''
  const appointments = db.prepare('SELECT * FROM appointments ORDER BY id DESC').all().map(apt => {
    const a = apps.find(x => x.id === apt.application_id)
    return {
      ...apt,
      application_id: num(apt.application_id),
      interview_id: num(apt.interview_id),
      reschedule_count: num(apt.reschedule_count),
      version: num(apt.version),
      duration_min: num(apt.duration_min),
      candidate_id: a ? num(a.candidate_id) : 0,
      candidate: a ? candName(a.candidate_id) : '',
      position: a ? posName(a.position_id) : '',
      app_stage: a ? a.stage : '',
      mode_label: MODE_LABEL[apt.mode] || apt.mode,
      status_label: APPOINTMENT_STATUS_LABEL[apt.status] || apt.status,
      start_fmt: fmtStart(apt.start_at),
      // 最近一条改期请求携带的新时间（前端「同意改期」直接展示）
      pending_reschedule: (() => {
        if (apt.status !== 'reschedule_requested') return null
        const m = db.prepare(`SELECT * FROM appointment_messages WHERE appointment_id=? AND kind='reschedule_request' ORDER BY id DESC LIMIT 1`).get(apt.id)
        return m ? { ...parseJSON(m.payload, {}), by: m.sender_name, side: m.side, content: m.content } : null
      })(),
      messages: loadMessages(apt.id).map(m => ({ ...m, payload: parseJSON(m.payload, {}) }))
    }
  })
  return { scheduleSlots: slots, appointments }
}

// ---------------- 路由：可用时段 ----------------
// 维护可用时段（招聘负责人可维护候选人/面试官任一侧；面试官仅维护本人）
router.post('/slots', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const ownerType = b.owner_type === 'interviewer' ? 'interviewer' : 'candidate'
  let userId = String(b.user_id || '')
  let candidateId = num(b.candidate_id)
  if (ownerType === 'interviewer') {
    if (user.role === 'interviewer') userId = user.id
    else if (!userId) badRequest('请选择面试官', 'interviewer_required')
    const u = db.prepare("SELECT * FROM users WHERE id=? AND role='interviewer'").get(userId)
    if (!u) badRequest('面试官不存在', 'interviewer_missing')
  } else {
    if (user.role === 'interviewer') forbidden('面试官不能维护候选人时段', 'role_not_allowed')
    const c = db.prepare('SELECT id FROM candidates WHERE id=?').get(candidateId)
    if (!c) badRequest('候选人不存在', 'candidate_missing')
  }
  const date = String(b.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) badRequest('请选择日期', 'date_required')
  const startTime = String(b.start_time || ''), endTime = String(b.end_time || '')
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || minuteOf(endTime) <= minuteOf(startTime)) {
    badRequest('请填写正确的起止时间', 'time_invalid')
  }
  const mode = ['onsite', 'video', 'phone'].includes(b.mode) ? b.mode : 'onsite'
  const out = tx(() => {
    // 同一天允许维护多个时段；完全重复（同归属+同起止+同方式且未取消）的时段拒绝重复
    const dup = db.prepare(`SELECT id FROM schedule_slots
      WHERE owner_type=? AND user_id=? AND candidate_id=? AND date=? AND start_time=? AND end_time=? AND mode=? AND status!='blocked'`)
      .get(ownerType, userId, candidateId, date, startTime, endTime, mode)
    if (dup) conflict('该时段已存在，请勿重复添加', 'slot_duplicate')
    const r = db.prepare(`INSERT INTO schedule_slots(owner_type,candidate_id,user_id,date,start_time,end_time,mode,status,created)
      VALUES(?,?,?,?,?,?,?, 'available', ?)`)
      .run(ownerType, candidateId, userId, date, startTime, endTime, mode, ts())
    return { id: Number(r.lastInsertRowid) }
  })
  res.json({ ok: true, ...out })
}))

// 删除/停用时段（已被预约锁定的时段不能直接删除，需先取消预约或完成面试）
router.post('/slots/:id/remove', wrap((req, res) => {
  const user = currentUser(req)
  const id = num(req.params.id)
  const out = tx(() => {
    const s = db.prepare('SELECT * FROM schedule_slots WHERE id=?').get(id)
    if (!s) return { notFound: true }
    if (s.owner_type === 'interviewer') {
      if (user.role === 'interviewer' && s.user_id !== user.id) forbidden('只能维护本人的可用时段', 'not_owner')
      if (user.role === 'hiring_manager') forbidden('当前角色不能维护面试官时段', 'role_not_allowed')
    } else if (user.role !== 'recruiter') {
      forbidden('候选人可用时段仅招聘负责人可维护', 'role_not_allowed')
    }
    if (s.status === 'booked') conflict('该时段已被预约锁定，请先取消对应预约', 'slot_booked')
    db.prepare('DELETE FROM schedule_slots WHERE id=?').run(id)
    return { ok: true }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// 查询候选人 × 面试官未来 N 天的时段交集（预约弹窗推荐）
router.get('/overlap/:appId/:userId', wrap((req, res) => {
  const appId = num(req.params.appId)
  const userId = String(req.params.userId)
  const days = Math.min(30, Math.max(1, num(req.query.days, 14)))
  const a = db.prepare('SELECT id FROM applications WHERE id=?').get(appId)
  const u = db.prepare("SELECT id FROM users WHERE id=? AND role='interviewer'").get(userId)
  if (!a || !u) return res.status(404).json({ ok: false })
  res.json({ ok: true, slots: overlapSlots(appId, userId, 0, days) })
}))

// ---------------- 路由：预约单 ----------------
router.post('/appointments', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const appId = num(b.application_id)
  const interviewerId = String(b.interviewer_user_id || '')
  const actorSide = user.role === 'interviewer' ? 'interviewer' : 'recruiter'
  if (user.role === 'hiring_manager') forbidden('用人经理不参与面试预约', 'role_not_allowed')
  const out = tx(() => {
    const a = db.prepare('SELECT * FROM applications WHERE id=?').get(appId)
    if (!a) return { notFound: true }
    const iv = db.prepare("SELECT * FROM users WHERE id=? AND role='interviewer'").get(interviewerId)
    if (!iv) badRequest('请选择面试官', 'interviewer_required')
    // 同一应聘同时只允许一个进行中的预约，避免多份预约互相占用时段
    const open = db.prepare(`SELECT id FROM appointments WHERE application_id=? AND status IN ('proposed','reschedule_requested','confirmed')`)
      .get(appId)
    if (open) conflict('该候选人已有进行中的预约，请先改期或取消后再重新提议', 'appointment_open')
    const id = proposeAppointment({
      a, interviewer: iv, round: String(b.round || '初试'),
      startAt: String(b.start_at || ''), endAt: b.end_at ? String(b.end_at) : '',
      durationMin: num(b.duration_min, 60), location: String(b.location || ''),
      mode: ['onsite', 'video', 'phone'].includes(b.mode) ? b.mode : 'onsite',
      actor: user, actorSide, onBehalfCandidate: !!b.on_behalf_candidate, note: String(b.note || '')
    })
    return { ok: true, id }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// 确认 / 婉拒。候选人侧无系统账号，由招聘负责人代操作（side=candidate）；面试官只能操作本人侧
router.post('/appointments/:id/ack', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const side = b.side === 'candidate' ? 'candidate' : 'interviewer'
  const accept = b.accept !== false
  if (side === 'candidate' && user.role !== 'recruiter') forbidden('候选人确认需由招聘负责人转达后代操作', 'role_not_allowed')
  if (side === 'interviewer' && user.role === 'recruiter' && !b.on_behalf) {
    forbidden('面试官侧确认需面试官本人操作（或勾选代操作）', 'role_not_allowed')
  }
  const out = tx(() => {
    const apt = getAppointment(num(req.params.id))
    if (!apt) return { notFound: true }
    if (side === 'interviewer' && user.role === 'interviewer' && apt.interviewer_user_id !== user.id) {
      forbidden('该预约不属于您，不能代为确认', 'not_owner')
    }
    ackAppointment(apt, { side, accept, actor: user, note: String(b.note || '') })
    return { ok: true, status: getAppointment(apt.id).status }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// 改期：action=request/accept/decline；request 携带新时间
router.post('/appointments/:id/reschedule', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const action = String(b.action || 'request')
  // 面试官侧动作由本人发起；候选人侧动作由招聘负责人代操作
  const side = user.role === 'interviewer' ? 'interviewer' : 'candidate'
  const out = tx(() => {
    const apt = getAppointment(num(req.params.id))
    if (!apt) return { notFound: true }
    if (user.role === 'hiring_manager') forbidden('用人经理不参与改期协商', 'role_not_allowed')
    if (side === 'interviewer' && apt.interviewer_user_id !== user.id) forbidden('该预约不属于您', 'not_owner')
    if (action === 'request') {
      if (!b.start_at) badRequest('改期请提供新的面试时间', 'start_at_required')
      requestReschedule(apt, {
        actor: user, actorSide: side,
        startAt: String(b.start_at), endAt: b.end_at ? String(b.end_at) : '',
        durationMin: num(b.duration_min, 60),
        location: b.location !== undefined ? String(b.location) : undefined,
        mode: b.mode !== undefined ? b.mode : undefined,
        note: String(b.note || '')
      })
    } else if (action === 'accept') {
      // 同意改期：面试官本人或招聘负责人（代候选人）均可
      respondReschedule(apt, { accept: true, actor: user, side, note: String(b.note || '') })
    } else if (action === 'decline') {
      respondReschedule(apt, { accept: false, actor: user, side, note: String(b.note || '') })
    } else {
      badRequest('改期动作仅支持 request/accept/decline', 'action_invalid')
    }
    return { ok: true, status: getAppointment(apt.id).status }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

router.post('/appointments/:id/cancel', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role === 'hiring_manager') forbidden('用人经理不参与预约取消', 'role_not_allowed')
  const b = req.body || {}
  const out = tx(() => {
    const apt = getAppointment(num(req.params.id))
    if (!apt) return { notFound: true }
    const side = user.role === 'interviewer' ? 'interviewer' : 'candidate'
    if (side === 'interviewer' && apt.interviewer_user_id !== user.id) forbidden('该预约不属于您', 'not_owner')
    cancelAppointment(apt, { actor: user, side, note: String(b.note || '') })
    return { ok: true, status: 'cancelled' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// 出席/缺席登记（招聘负责人）；候选人缺席联动流程淘汰
router.post('/appointments/:id/attendance', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  if (user.role !== 'recruiter') forbidden('出席情况由招聘负责人登记', 'role_not_allowed')
  const out = tx(() => {
    const apt = getAppointment(num(req.params.id))
    if (!apt) return { notFound: true }
    markAttendance(apt, { result: String(b.result || ''), actor: user, note: String(b.note || '') })
    return { ok: true, status: getAppointment(apt.id).status }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

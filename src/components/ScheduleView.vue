<script setup>
import { computed, ref, watch } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const tab = ref('appointments')
const filter = ref('action')
const detail = ref(null) // 当前打开的预约单（每次从 store 取最新数据）

const isRecruiter = computed(() => store.myRole === 'recruiter')
const isInterviewer = computed(() => store.myRole === 'interviewer')
const me = computed(() => store.currentUser)

const STATUS_STYLE = {
  proposed: ['⏳', 'st-proposed'], reschedule_requested: ['🔁', 'st-rs'],
  confirmed: ['✅', 'st-confirmed'], declined: ['🙅', 'st-declined'],
  cancelled: ['❌', 'st-cancel'], completed: ['🎉', 'st-done'],
  candidate_noshow: ['⚠️', 'st-cnoshow'], interviewer_noshow: ['⚠️', 'st-inoshow']
}
const MODE_ICON = { onsite: '🏢 现场', video: '🎥 视频', phone: '📞 电话' }
const ACK_ICON = { pending: '⏳', accepted: '✅', declined: '🙅' }
const ACK_TEXT = { pending: '待确认', accepted: '已接受', declined: '已婉拒' }

// ---------------- 列表筛选与待办 ----------------
const OPEN = ['proposed', 'reschedule_requested', 'confirmed']
function isIvOwner(a) { return isInterviewer.value && a.interviewer_user_id === me.value?.id }
// 该预约是否在等「我」处理：面试官等本人 ack / 回应改期；招聘负责人代候选人 ack / 回应改期 / 登记出席
function awaitingMe(a) {
  if (a.status === 'proposed') {
    if (isIvOwner(a) && a.interviewer_ack === 'pending') return true
    if (isRecruiter.value && a.candidate_ack === 'pending') return true
  }
  if (a.status === 'reschedule_requested' && a.pending_reschedule) {
    if (isIvOwner(a) && a.pending_reschedule.side === 'candidate') return true
    if (isRecruiter.value && a.pending_reschedule.side === 'interviewer') return true
  }
  if (isRecruiter.value && a.overdue_at && a.status === 'confirmed') return true
  return false
}
const counts = computed(() => ({
  mine: store.appointments.filter(awaitingMe).length,
  open: store.appointments.filter(a => OPEN.includes(a.status)).length,
  overdue: store.appointments.filter(a => a.status === 'confirmed' && a.overdue_at).length,
  done: store.appointments.filter(a => ['completed', 'candidate_noshow', 'interviewer_noshow', 'cancelled', 'declined'].includes(a.status)).length
}))
const list = computed(() => {
  const all = store.appointments
  if (filter.value === 'action') return all.filter(awaitingMe)
  if (filter.value === 'open') return all.filter(a => OPEN.includes(a.status))
  if (filter.value === 'overdue') return all.filter(a => a.status === 'confirmed' && a.overdue_at)
  if (filter.value === 'noshow') return all.filter(a => ['candidate_noshow', 'interviewer_noshow'].includes(a.status))
  return all
})
// 详情始终取刷新后的最新行
const liveDetail = computed(() => store.appointments.find(a => a.id === detail.value?.id) || null)

// ---------------- 提议预约 ----------------
const proposeModal = ref(false)
const pAppId = ref(0)
const pInterviewer = ref('')
const pStart = ref('')
const pEnd = ref('')
const pMode = ref('onsite')
const pLocation = ref('')
const pNote = ref('')
const pOnBehalf = ref(false)
const overlaps = ref([])
const loadingOverlap = ref(false)

const interviewers = computed(() => store.users.filter(u => u.role === 'interviewer'))
const appOptions = computed(() => store.applications.filter(a =>
  !['hired', 'rejected'].includes(a.stage) &&
  !store.appointments.some(ap => ap.application_id === a.id && OPEN.includes(ap.status))))
const pApp = computed(() => store.applications.find(a => a.id === pAppId.value) || null)

const roundOpts = ['初试', '复试', '终面', 'HR面']
const nextRoundOf = appId => {
  const used = new Set((store.applications.find(a => a.id === appId)?.interviews || []).map(i => i.round))
  return roundOpts.find(r => !used.has(r)) || `第${(store.applications.find(a => a.id === appId)?.interviews?.length || 0) + 1}轮`
}
const pRound = ref('初试')

function pad2(n) { return String(n).padStart(2, '0') }
function defaultStart(days = 1, hour = 10) {
  const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
function openPropose(appId = 0) {
  if (!isRecruiter.value && !isInterviewer.value) { store.notify('error', '当前身份不参与面试预约'); return }
  pAppId.value = appId || appOptions.value[0]?.id || 0
  pInterviewer.value = isInterviewer.value ? me.value.id : (interviewers.value[0]?.id || '')
  pRound.value = nextRoundOf(pAppId.value)
  pStart.value = defaultStart(1)
  pEnd.value = ''
  pMode.value = 'onsite'
  pLocation.value = ''
  pNote.value = ''
  pOnBehalf.value = false
  overlaps.value = []
  proposeModal.value = true
}
watch([pAppId], () => { pRound.value = nextRoundOf(pAppId.value); overlaps.value = [] })
watch([pAppId, pInterviewer, proposeModal], async () => {
  if (!proposeModal.value || !pAppId.value || !pInterviewer.value) { overlaps.value = []; return }
  loadingOverlap.value = true
  const r = await store.scheduleOverlap(pAppId.value, pInterviewer.value, 14)
  overlaps.value = r?.slots || []
  loadingOverlap.value = false
})
function pickOverlap(s) {
  pStart.value = `${s.date}T${s.start_time}`
  pEnd.value = `${s.date}T${s.end_time}`
  pMode.value = s.mode
}
function submitPropose() {
  if (!pAppId.value) return store.notify('error', '请选择应聘候选人')
  if (!pInterviewer.value) return store.notify('error', '请选择面试官')
  if (!pStart.value) return store.notify('error', '请选择面试时间')
  store.proposeAppointment({
    application_id: pAppId.value,
    interviewer_user_id: pInterviewer.value,
    round: pRound.value,
    start_at: pStart.value,
    end_at: pEnd.value || undefined,
    mode: pMode.value,
    location: pLocation.value,
    on_behalf_candidate: isRecruiter.value && pOnBehalf.value,
    note: pNote.value
  })
  proposeModal.value = false
}

// ---------------- 预约单操作 ----------------
function openDetail(a) { detail.value = a }
function ack(a, accept) {
  const side = isInterviewer.value ? 'interviewer' : 'candidate'
  if (!accept) { openNote({ kind: `decline:${side}`, title: side === 'interviewer' ? '面试官婉拒' : '代候选人婉拒', appt: a }); return }
  store.ackAppointment(a.id, { side, accept: true })
}
// 招聘负责人代面试官本人场景较少；面试官侧按钮只对本人生效（服务端同样校验）
function requestRs(a) {
  rsAppt.value = a
  rsStart.value = a.pending_reschedule?.start_at?.slice(0, 16) || defaultStart(1, a.start_at?.slice(11, 13) * 1 || 10)
  rsEnd.value = ''
  rsMode.value = a.pending_reschedule?.mode || a.mode
  rsLocation.value = a.location
  rsNote.value = ''
  rsModal.value = true
}
const rsModal = ref(false)
const rsAppt = ref(null)
const rsStart = ref('')
const rsEnd = ref('')
const rsMode = ref('onsite')
const rsLocation = ref('')
const rsNote = ref('')
function submitRs() {
  if (!rsStart.value) return store.notify('error', '请选择新的面试时间')
  store.rescheduleAppointment(rsAppt.value.id, {
    action: 'request', start_at: rsStart.value, end_at: rsEnd.value || undefined,
    mode: rsMode.value, location: rsLocation.value, note: rsNote.value
  })
  rsModal.value = false
}
function respondRs(a, accept) {
  const side = isInterviewer.value ? 'interviewer' : 'candidate'
  if (!accept) { openNote({ kind: 'rs-decline', title: '拒绝改期（维持原约）', appt: a }); return }
  store.rescheduleAppointment(a.id, { action: 'accept', side })
}
function cancelApt(a) { openNote({ kind: 'cancel', title: '取消面试预约', appt: a }) }

// 登记出席/缺席
const attModal = ref({ open: false })
const attAppt = ref(null)
const attResult = ref('attended')
const attNote = ref('')
function openAttendance(a, result) {
  attAppt.value = a
  attResult.value = result
  attNote.value = result === 'candidate_noshow' ? '候选人未到场且未提前改期' : ''
  attModal.value = true
}
function submitAttendance() {
  store.markAttendance(attAppt.value.id, attResult.value, attNote.value)
  attModal.value = false
}

// 带说明的通用弹窗（婉拒/拒绝改期/取消/缺席留痕）
const noteModal = ref({ open: false, kind: '', title: '', value: '', appt: null })
function openNote({ kind, title, appt }) {
  noteModal.value = { open: true, kind, title, value: '', appt }
}
function confirmNote() {
  const { kind, appt, value } = noteModal.value
  if (kind.startsWith('decline:')) {
    const side = kind.split(':')[1]
    if (!value.trim()) return store.notify('error', '请填写婉拒原因，便于对方重新提议')
    store.ackAppointment(appt.id, { side, accept: false, note: value })
  } else if (kind === 'rs-decline') {
    if (!value.trim()) return store.notify('error', '请填写拒绝改期的原因')
    store.rescheduleAppointment(appt.id, { action: 'decline', side: isInterviewer.value ? 'interviewer' : 'candidate', note: value })
  } else if (kind === 'cancel') {
    if (!value.trim()) return store.notify('error', '取消预约请填写原因并通知对方')
    store.cancelAppointment(appt.id, value)
  }
  noteModal.value.open = false
}

// ---------------- 可用时段维护 ----------------
const ownerType = ref(isInterviewer.value ? 'interviewer' : 'candidate')
const selInterviewer = ref(interviewers.value[0]?.id || '')
const selCandidate = ref(store.candidates[0]?.id || 0)
const slotDate = ref(defaultStart(1).slice(0, 10))
const slotStart = ref('10:00')
const slotEnd = ref('11:00')
const slotMode = ref('onsite')

watch(me, () => { if (isInterviewer.value) ownerType.value = 'interviewer' })
const shownSlots = computed(() => {
  if (ownerType.value === 'interviewer') {
    return store.scheduleSlots.filter(s => s.owner_type === 'interviewer' && s.user_id === selInterviewer.value)
  }
  return store.scheduleSlots.filter(s => s.owner_type === 'candidate' && s.candidate_id === selCandidate.value)
})
const slotsByDate = computed(() => {
  const m = new Map()
  shownSlots.value.forEach(s => {
    if (!m.has(s.date)) m.set(s.date, [])
    m.get(s.date).push(s)
  })
  return [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
})
function addSlot() {
  if (slotEnd.value <= slotStart.value) return store.notify('error', '结束时间需晚于开始时间')
  if (ownerType.value === 'interviewer') {
    store.addSlot({ owner_type: 'interviewer', user_id: selInterviewer.value, date: slotDate.value, start_time: slotStart.value, end_time: slotEnd.value, mode: slotMode.value })
  } else {
    if (!selCandidate.value) return store.notify('error', '请选择候选人')
    store.addSlot({ owner_type: 'candidate', candidate_id: selCandidate.value, date: slotDate.value, start_time: slotStart.value, end_time: slotEnd.value, mode: slotMode.value })
  }
}
function removeSlot(s) { store.removeSlot(s.id) }

const MSG_ICON = {
  propose: '📨', accept: '✅', decline: '🙅', reschedule_request: '🔁',
  reschedule_accept: '📅', reschedule_decline: '🚫', confirm: '🎉',
  cancel: '❌', remind: '🔔', attend: '✅', noshow: '⚠️'
}
const senderTag = m => ({
  recruiter: ['招聘负责人', 'tag-rc'], interviewer: ['面试官', 'tag-iv'],
  candidate: ['候选人', 'tag-cd'], system: ['系统', 'tag-sys']
}[m.sender_type] || ['系统', 'tag-sys'])
</script>

<template>
  <div class="sched">
    <!-- 顶部统计 + 操作 -->
    <div class="stat-row">
      <div class="stat card" :class="{ hot: counts.mine }" @click="filter = 'action'; tab = 'appointments'">
        <b>{{ counts.mine }}</b><span>待我处理</span>
      </div>
      <div class="stat card" @click="filter = 'open'; tab = 'appointments'">
        <b>{{ counts.open }}</b><span>进行中预约</span>
      </div>
      <div class="stat card" :class="{ hot: counts.overdue }" @click="filter = 'overdue'; tab = 'appointments'">
        <b>{{ counts.overdue }}</b><span>超时待登记</span>
      </div>
      <div class="stat card" @click="filter = 'noshow'; tab = 'appointments'">
        <b>{{ counts.done }}</b><span>已结束/缺席</span>
      </div>
      <div class="stat-actions">
        <button class="ghost" :class="{ on: tab === 'slots' }" @click="tab = tab === 'slots' ? 'appointments' : 'slots'">
          {{ tab === 'slots' ? '📋 返回预约' : '🕐 可用时段' }}
        </button>
        <button class="primary" @click="openPropose()" :disabled="store.myRole === 'hiring_manager'">＋ 发起面试预约</button>
      </div>
    </div>

    <!-- ================= 预约列表 ================= -->
    <template v-if="tab === 'appointments'">
      <div class="filters">
        <button v-for="f in [['action','待我处理'],['open','进行中'],['overdue','超时待登记'],['noshow','缺席记录'],['all','全部']]" :key="f[0]"
          class="ghost" :class="{ on: filter === f[0] }" @click="filter = f[0]">{{ f[1] }}</button>
      </div>
      <div class="alist">
        <div class="acard card" v-for="a in list" :key="a.id" @click="openDetail(a)">
          <div class="ac-head">
            <b>{{ a.candidate }}</b>
            <span class="tag">{{ a.position }}</span>
            <span class="rtag">{{ a.round }}</span>
            <span class="st" :class="STATUS_STYLE[a.status]?.[1]">{{ STATUS_STYLE[a.status]?.[0] }} {{ a.status_label }}</span>
          </div>
          <div class="ac-time">
            <span class="clock">🕑 {{ a.start_fmt }}</span>
            <span class="tag">{{ MODE_ICON[a.mode] }}</span>
            <span class="muted" v-if="a.location">📍 {{ a.location }}</span>
          </div>
          <div class="ac-sub muted">面试官：{{ a.interviewer_name }} · 提议人 {{ a.proposed_by_name }}</div>
          <div class="acks">
            <span class="ack" :class="a.candidate_ack">候选人 {{ ACK_ICON[a.candidate_ack] }} {{ ACK_TEXT[a.candidate_ack] }}</span>
            <span class="ack" :class="a.interviewer_ack">面试官 {{ ACK_ICON[a.interviewer_ack] }} {{ ACK_TEXT[a.interviewer_ack] }}</span>
            <span v-if="a.reschedule_count" class="rs-count">🔁 已改期 {{ a.reschedule_count }} 次</span>
          </div>
          <div class="ac-warn" v-if="a.status === 'confirmed' && a.overdue_at" @click.stop>
            ⚠️ 已过面试时间仍未登记出席 ——
            <button class="warn sm" @click="openAttendance(a, 'attended')">已出席</button>
            <button class="danger sm" @click="openAttendance(a, 'candidate_noshow')">候选人缺席</button>
            <button class="ghost sm" @click="openAttendance(a, 'interviewer_noshow')">面试官缺席</button>
          </div>
          <div class="ac-warn rs-warn" v-else-if="a.status === 'reschedule_requested' && a.pending_reschedule">
            🔁 {{ a.pending_reschedule.by }} 申请改至 <b>{{ a.pending_reschedule.start_at?.replace('T', ' ').slice(0, 16) }}</b>
            <span v-if="awaitingMe" class="muted">（待您回应，点击查看）</span>
          </div>
        </div>
        <div class="card empty" v-if="!list.length">暂无相关预约，可由招聘负责人或面试官「发起面试预约」。</div>
      </div>
    </template>

    <!-- ================= 可用时段 ================= -->
    <template v-else>
      <div class="card slot-panel">
        <div class="slot-tabs">
          <button class="ghost" :class="{ on: ownerType === 'interviewer' }" @click="ownerType = 'interviewer'" :disabled="isInterviewer">💬 面试官可用时段</button>
          <button class="ghost" :class="{ on: ownerType === 'candidate' }" @click="ownerType = 'candidate'" :disabled="!isRecruiter">👥 候选人可用时段</button>
          <select v-if="ownerType === 'interviewer'" v-model="selInterviewer" :disabled="isInterviewer">
            <option v-for="u in interviewers" :key="u.id" :value="u.id">{{ u.name }}</option>
          </select>
          <select v-else v-model="selCandidate">
            <option v-for="c in store.candidates" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>

        <div class="slot-add">
          <label>日期 <input type="date" v-model="slotDate" /></label>
          <label>开始 <input type="time" v-model="slotStart" /></label>
          <label>结束 <input type="time" v-model="slotEnd" /></label>
          <label>方式
            <select v-model="slotMode">
              <option value="onsite">🏢 现场</option>
              <option value="video">🎥 视频</option>
              <option value="phone">📞 电话</option>
            </select>
          </label>
          <button class="primary" @click="addSlot">＋ 添加时段</button>
          <span class="muted">预约确认后命中的时段会自动锁定；仅面试方式相同的双方时段交集才会被推荐。</span>
        </div>

        <div class="slot-days">
          <div class="slot-day" v-for="[date, slots] in slotsByDate" :key="date">
            <div class="slot-date">{{ date }} <span class="muted">{{ ['周日','周一','周二','周三','周四','周五','周六'][new Date(date + 'T00:00').getDay()] }}</span></div>
            <div class="slot-items">
              <span class="slot-chip" v-for="s in slots" :key="s.id" :class="{ booked: s.status === 'booked' }">
                {{ s.start_time }}–{{ s.end_time }} {{ MODE_ICON[s.mode] }}
                <em v-if="s.status === 'booked'">已锁定 #{{ s.booked_appointment_id }}</em>
                <button v-else class="x" title="删除时段" @click="removeSlot(s)">×</button>
              </span>
            </div>
          </div>
          <div class="empty" v-if="!slotsByDate.length">尚未维护可用时段，先添加一条吧。</div>
        </div>
      </div>
    </template>

    <!-- ================= 预约详情（协商时间线 + 操作） ================= -->
    <div class="modal" v-if="liveDetail" @click.self="detail = null">
      <div class="modal-box wide card detail-box">
        <div class="d-head">
          <h3>🤝 面试预约沟通 · {{ liveDetail.candidate }} <span class="tag">{{ liveDetail.position }}</span>
            <span class="rtag">{{ liveDetail.round }}</span>
            <span class="st" :class="STATUS_STYLE[liveDetail.status]?.[1]">{{ STATUS_STYLE[liveDetail.status]?.[0] }} {{ liveDetail.status_label }}</span>
          </h3>
          <button class="ghost sm" @click="detail = null">关闭</button>
        </div>

        <div class="d-grid">
          <!-- 左：信息与操作 -->
          <div class="d-main">
            <div class="info-grid">
              <div><em class="muted">面试时间</em><b>🕑 {{ liveDetail.start_fmt }}</b></div>
              <div><em class="muted">时长</em><b>{{ liveDetail.duration_min }} 分钟</b></div>
              <div><em class="muted">面试官</em><b>💬 {{ liveDetail.interviewer_name }}</b></div>
              <div><em class="muted">面试方式</em><b>{{ MODE_ICON[liveDetail.mode] }}</b></div>
              <div class="span2"><em class="muted">地点/会议链接</em><b>📍 {{ liveDetail.location || '待定' }}</b></div>
            </div>
            <div class="acks-box">
              <div class="ack-line" :class="liveDetail.candidate_ack">
                候选人：{{ ACK_ICON[liveDetail.candidate_ack] }} {{ ACK_TEXT[liveDetail.candidate_ack] }}
                <em class="muted" v-if="liveDetail.candidate_ack_at">{{ liveDetail.candidate_ack_at }}</em>
              </div>
              <div class="ack-line" :class="liveDetail.interviewer_ack">
                面试官：{{ ACK_ICON[liveDetail.interviewer_ack] }} {{ ACK_TEXT[liveDetail.interviewer_ack] }}
                <em class="muted" v-if="liveDetail.interviewer_ack_at">{{ liveDetail.interviewer_ack_at }}</em>
              </div>
            </div>

            <!-- 改期请求卡片 -->
            <div class="rs-card card" v-if="liveDetail.status === 'reschedule_requested' && liveDetail.pending_reschedule">
              <div class="rs-title">🔁 {{ liveDetail.pending_reschedule.by }} 申请改期</div>
              <div class="muted">{{ liveDetail.pending_reschedule.content }}</div>
              <template v-if="(isIvOwner(liveDetail) && liveDetail.pending_reschedule.side === 'candidate')
                || (isRecruiter && liveDetail.pending_reschedule.side === 'interviewer')">
                <div class="acts">
                  <button class="succ" @click="respondRs(liveDetail, true)">✅ 同意改期（同步更新面试记录）</button>
                  <button class="danger" @click="respondRs(liveDetail, false)">🚫 拒绝，维持原约</button>
                </div>
              </template>
              <div class="muted" v-else>等待对方回应改期请求…</div>
            </div>

            <!-- 操作区 -->
            <div class="acts d-acts">
              <template v-if="liveDetail.status === 'proposed'">
                <template v-if="isIvOwner(liveDetail) && liveDetail.interviewer_ack === 'pending'">
                  <button class="succ" @click="ack(liveDetail, true)">✅ 接受预约</button>
                  <button class="danger" @click="ack(liveDetail, false)">🙅 婉拒（需填原因）</button>
                </template>
                <template v-if="isRecruiter && liveDetail.candidate_ack === 'pending'">
                  <button class="succ" @click="ack(liveDetail, true)">✅ 代候选人确认接受</button>
                  <button class="danger" @click="ack(liveDetail, false)">🙅 代候选人婉拒</button>
                  <span class="muted">候选人无系统账号，由招聘负责人电话/邮件沟通后代操作。</span>
                </template>
              </template>

              <template v-if="liveDetail.status === 'confirmed'">
                <button class="warn" @click="requestRs(liveDetail)"
                  :disabled="isRecruiter ? false : !isIvOwner(liveDetail)">🔁 申请改期</button>
                <button class="ghost danger-text" @click="cancelApt(liveDetail)"
                  :disabled="isRecruiter ? false : !isIvOwner(liveDetail)">❌ 取消预约</button>
              </template>

              <template v-if="liveDetail.status === 'declined'">
                <button class="primary" @click="openPropose(liveDetail.application_id)">＋ 按双方时段重新提议</button>
              </template>

              <template v-if="isRecruiter && liveDetail.status === 'confirmed'">
                <span class="divider"></span>
                <button class="succ" @click="openAttendance(liveDetail, 'attended')">✅ 双方已出席</button>
                <button class="danger" @click="openAttendance(liveDetail, 'candidate_noshow')">⚠️ 候选人缺席（联动淘汰）</button>
                <button class="warn" @click="openAttendance(liveDetail, 'interviewer_noshow')">⚠️ 面试官缺席（可重约）</button>
              </template>
            </div>
            <div class="muted tip" v-if="liveDetail.status === 'confirmed' && !liveDetail.overdue_at">
              系统将在面试前 24 小时与 2 小时自动提醒；结束后 15 分钟仍未登记将挂出「超时待登记」。
            </div>
            <div class="muted tip warn-tip" v-if="liveDetail.overdue_at && liveDetail.status === 'confirmed'">
              本场面试已超时未登记出席情况，请尽快确认出席或缺席（候选人缺席将联动流程淘汰，可在招聘流程异常回退复活）。
            </div>
          </div>

          <!-- 右：协商时间线（只追加消息） -->
          <div class="d-msgs">
            <div class="msgs-title">📜 沟通记录（全程留痕）</div>
            <div class="msg" v-for="m in liveDetail.messages" :key="m.id" :class="{ sys: m.sender_type === 'system' }">
              <span class="msg-icon">{{ MSG_ICON[m.kind] || '📌' }}</span>
              <div class="msg-body">
                <div class="msg-meta">
                  <span class="sender-tag" :class="senderTag(m)[1]">{{ senderTag(m)[0] }} · {{ m.sender_name || '系统' }}</span>
                  <em class="muted">{{ m.created }}</em>
                </div>
                <p>{{ m.content }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 提议预约弹窗 -->
    <div class="modal" v-if="proposeModal" @click.self="proposeModal = false">
      <div class="modal-box card">
        <h3>📨 发起面试预约</h3>
        <div class="form-row">
          <label>应聘候选人
            <select v-model="pAppId">
              <option v-for="a in appOptions" :key="a.id" :value="a.id">{{ a.candidate }} · {{ a.position }}（{{ a.stage }}）</option>
            </select>
          </label>
          <label>轮次
            <select v-model="pRound">
              <option v-for="r in roundOpts" :key="r" :value="r">{{ r }}</option>
            </select>
          </label>
        </div>
        <div class="form-row">
          <label style="flex:1">面试官
            <select v-model="pInterviewer" :disabled="isInterviewer">
              <option v-for="u in interviewers" :key="u.id" :value="u.id">{{ u.name }}</option>
            </select>
          </label>
          <label>方式
            <select v-model="pMode">
              <option value="onsite">🏢 现场</option>
              <option value="video">🎥 视频</option>
              <option value="phone">📞 电话</option>
            </select>
          </label>
        </div>
        <div class="form-row">
          <label>开始时间 <input type="datetime-local" v-model="pStart" /></label>
          <label>结束时间 <input type="datetime-local" v-model="pEnd" /></label>
        </div>
        <label class="full">地点 / 会议链接 <input v-model="pLocation" placeholder="如：3 楼 302 会议室 / 腾讯会议链接" /></label>
        <label class="full">给对方的留言（可选） <input v-model="pNote" placeholder="如：请提前 10 分钟到场，携带作品集" /></label>
        <label class="check-line" v-if="isRecruiter">
          <input type="checkbox" v-model="pOnBehalf" />
          已与候选人电话/邮件确认该时间，直接代候选人接受（面试官确认后预约即刻生效）
        </label>

        <div class="overlap-box">
          <div class="overlap-title">🕐 双方可用时段交集（未来 14 天，点击直接填入）
            <span class="muted">{{ loadingOverlap ? '加载中…' : `共 ${overlaps.length} 段` }}</span>
          </div>
          <div class="overlap-list">
            <button class="ov-chip" v-for="(s, i) in overlaps" :key="i"
              :class="{ on: pStart === `${s.date}T${s.start_time}` }" @click="pickOverlap(s)">
              {{ s.date }} {{ s.start_time }}–{{ s.end_time }} {{ MODE_ICON[s.mode] }}
            </button>
            <span class="muted" v-if="!loadingOverlap && !overlaps.length">暂无相同面试方式的时段交集，可先在「可用时段」中补充，或直接手动选择时间提议。</span>
          </div>
        </div>

        <div class="acts">
          <button class="primary" @click="submitPropose">发送预约提议</button>
          <button class="ghost" @click="proposeModal = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 改期弹窗 -->
    <div class="modal" v-if="rsModal" @click.self="rsModal = false">
      <div class="modal-box card">
        <h3>🔁 申请改期 · {{ rsAppt?.candidate }}</h3>
        <div class="muted" style="margin-bottom:10px">原约定时间：{{ rsAppt?.start_fmt }}（{{ rsAppt?.round }}）</div>
        <div class="form-row">
          <label>新开始时间 <input type="datetime-local" v-model="rsStart" /></label>
          <label>新结束时间 <input type="datetime-local" v-model="rsEnd" /></label>
        </div>
        <div class="form-row">
          <label>方式
            <select v-model="rsMode">
              <option value="onsite">🏢 现场</option>
              <option value="video">🎥 视频</option>
              <option value="phone">📞 电话</option>
            </select>
          </label>
        </div>
        <label class="full">新地点/会议链接 <input v-model="rsLocation" /></label>
        <label class="full">改期原因 <input v-model="rsNote" placeholder="如：候选人临时有课 / 面试官出差，需协调" /></label>
        <div class="acts">
          <button class="warn" @click="submitRs">发送改期请求</button>
          <button class="ghost" @click="rsModal = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 出席登记弹窗 -->
    <div class="modal" v-if="attModal.open" @click.self="attModal.open = false">
      <div class="modal-box card">
        <h3>{{ attResult === 'attended' ? '✅ 登记出席' : '⚠️ 登记缺席' }} · {{ attAppt?.candidate }}</h3>
        <div v-if="attResult === 'candidate_noshow'" class="warn-box">
          候选人缺席将<b>联动淘汰该应聘流程</b>（写入淘汰事件、撤回待回应 Offer）；如属误判可在「招聘流程」中异常回退复活。
        </div>
        <div v-else-if="attResult === 'interviewer_noshow'" class="warn-box iv">
          面试官缺席不会影响候选人流程，请尽快与候选人沟通并重新发起预约。
        </div>
        <label class="full">备注 <input v-model="attNote" placeholder="到场情况 / 联系结果 / 后续安排" /></label>
        <div class="acts">
          <button :class="attResult === 'attended' ? 'succ' : 'danger'" @click="submitAttendance">确认登记</button>
          <button class="ghost" @click="attModal.open = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 通用原因弹窗 -->
    <div class="modal" v-if="noteModal.open" @click.self="noteModal.open = false">
      <div class="modal-box card">
        <h3>{{ noteModal.title }}</h3>
        <label class="full">说明（必填，将进入沟通记录并通知对方）
          <input v-model="noteModal.value" placeholder="请填写原因…" @keyup.enter="confirmNote" />
        </label>
        <div class="acts">
          <button class="primary" @click="confirmNote">确认</button>
          <button class="ghost" @click="noteModal.open = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sched { display: flex; flex-direction: column; gap: 14px; }
.stat-row { display: flex; gap: 12px; align-items: stretch; }
.stat { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; cursor: pointer; padding: 14px; }
.stat b { font-size: 26px; color: var(--accent); }
.stat span { font-size: 12px; color: var(--muted); }
.stat.hot { border-color: rgba(255,209,102,.5); box-shadow: 0 0 0 1px rgba(255,209,102,.25); }
.stat.hot b { color: var(--accent2); }
.stat-actions { display: flex; gap: 8px; align-items: center; }
.stat-actions button { white-space: nowrap; }
button.on { border-color: var(--accent); color: var(--accent); }
.filters { display: flex; gap: 8px; }
.alist { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.acard { cursor: pointer; transition: .18s; display: flex; flex-direction: column; gap: 8px; }
.acard:hover { border-color: var(--accent); transform: translateY(-2px); }
.ac-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ac-head b { font-size: 15px; }
.rtag { font-size: 11px; background: var(--panel2); border: 1px solid var(--border); padding: 2px 8px; border-radius: 10px; }
.st { margin-left: auto; font-size: 12px; padding: 2px 9px; border-radius: 10px; border: 1px solid; }
.st-proposed { color: var(--accent2); border-color: rgba(255,209,102,.45); background: rgba(255,209,102,.08); }
.st-rs { color: var(--cyan); border-color: rgba(79,195,247,.45); background: rgba(79,195,247,.08); }
.st-confirmed { color: var(--green); border-color: rgba(87,214,160,.45); background: rgba(87,214,160,.08); }
.st-declined, .st-cancel { color: var(--muted); border-color: var(--border); background: var(--panel2); }
.st-done { color: var(--green); border-color: rgba(87,214,160,.35); background: rgba(87,214,160,.05); }
.st-cnoshow { color: var(--red); border-color: rgba(255,107,122,.5); background: rgba(255,107,122,.1); }
.st-inoshow { color: var(--accent2); border-color: rgba(255,209,102,.5); background: rgba(255,209,102,.1); }
.ac-time { display: flex; gap: 10px; align-items: center; font-size: 14px; }
.clock { font-weight: 600; }
.ac-sub { font-size: 12px; }
.acks { display: flex; gap: 8px; flex-wrap: wrap; }
.ack { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border); color: var(--muted); background: var(--panel2); }
.ack.accepted { color: var(--green); border-color: rgba(87,214,160,.4); }
.ack.declined { color: var(--red); border-color: rgba(255,107,122,.4); }
.rs-count { font-size: 11px; color: var(--cyan); }
.ac-warn { font-size: 12px; color: var(--red); background: rgba(255,107,122,.08); border: 1px solid rgba(255,107,122,.35); border-radius: 8px; padding: 7px 9px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ac-warn.rs-warn { color: var(--cyan); background: rgba(79,195,247,.08); border-color: rgba(79,195,247,.35); }
button.sm { padding: 2px 8px; font-size: 11px; }
.danger-text { color: var(--red); }

/* 可用时段 */
.slot-panel { display: flex; flex-direction: column; gap: 16px; }
.slot-tabs { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.slot-tabs select { min-width: 160px; }
.slot-add { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.slot-add label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.slot-add .muted { flex: 1; min-width: 220px; }
.slot-days { display: flex; flex-direction: column; gap: 10px; }
.slot-date { font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.slot-items { display: flex; gap: 8px; flex-wrap: wrap; }
.slot-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 5px 10px; border-radius: 16px; background: var(--panel2); border: 1px solid var(--border); }
.slot-chip.booked { color: var(--muted); border-style: dashed; }
.slot-chip em { font-style: normal; font-size: 10px; color: var(--accent2); }
.slot-chip .x { padding: 0 6px; background: transparent; border: none; color: var(--red); font-size: 14px; line-height: 1; }

/* 详情 */
.detail-box { width: min(960px, 95vw); }
.d-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.d-head h3 { flex: 1; flex-wrap: wrap; }
.d-grid { display: grid; grid-template-columns: 1.15fr .85fr; gap: 16px; }
.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.info-grid > div { display: flex; flex-direction: column; gap: 3px; }
.info-grid .span2 { grid-column: span 2; }
.info-grid em { font-style: normal; font-size: 11px; }
.acks-box { display: flex; gap: 10px; margin: 10px 0; }
.ack-line { flex: 1; font-size: 12.5px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel2); display: flex; flex-direction: column; gap: 2px; }
.ack-line.accepted { border-color: rgba(87,214,160,.45); color: var(--green); }
.ack-line.declined { border-color: rgba(255,107,122,.45); color: var(--red); }
.ack-line em { font-size: 10.5px; }
.rs-card { border-color: rgba(79,195,247,.4); background: rgba(79,195,247,.06); display: flex; flex-direction: column; gap: 8px; }
.rs-title { font-weight: 600; color: var(--cyan); }
.d-acts { margin-top: 4px; }
.d-acts .divider { width: 100%; height: 1px; background: var(--border); margin: 4px 0; }
.tip { margin-top: 8px; line-height: 1.5; }
.warn-tip { color: var(--red); }
.d-msgs { border-left: 1px solid var(--border); padding-left: 14px; display: flex; flex-direction: column; gap: 10px; max-height: 560px; overflow-y: auto; }
.msgs-title { font-size: 13px; font-weight: 600; position: sticky; top: 0; background: var(--panel); padding-bottom: 6px; }
.msg { display: flex; gap: 8px; }
.msg-icon { font-size: 14px; padding-top: 1px; }
.msg-body { min-width: 0; }
.msg-meta { display: flex; gap: 8px; align-items: center; }
.msg-meta em { font-size: 10.5px; }
.msg p { font-size: 12.5px; line-height: 1.55; margin-top: 2px; color: var(--text); }
.msg.sys .msg-body p { color: var(--muted); }
.sender-tag { font-size: 10px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--border); font-style: normal; }
.tag-rc { color: var(--accent2); border-color: rgba(255,209,102,.4); }
.tag-iv { color: var(--cyan); border-color: rgba(79,195,247,.4); }
.tag-cd { color: var(--green); border-color: rgba(87,214,160,.4); }
.tag-sys { color: var(--muted); }

/* 表单弹窗 */
.form-row { display: flex; gap: 10px; margin-bottom: 10px; }
.form-row label { flex: 1; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
label.full { display: block; font-size: 12px; color: var(--muted); margin-bottom: 10px; }
label.full input { width: 100%; margin-top: 4px; }
.check-line { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); margin-bottom: 12px; cursor: pointer; }
.check-line input { width: auto; }
.overlap-box { border: 1px solid var(--border); border-radius: 10px; padding: 10px; margin: 6px 0 12px; background: var(--panel2); }
.overlap-title { font-size: 12.5px; margin-bottom: 8px; display: flex; gap: 8px; align-items: baseline; }
.overlap-list { display: flex; gap: 8px; flex-wrap: wrap; }
.ov-chip { font-size: 12px; padding: 5px 10px; border-radius: 14px; }
.ov-chip.on { border-color: var(--green); color: var(--green); }
.warn-box { font-size: 12.5px; line-height: 1.6; border-radius: 8px; padding: 10px; margin-bottom: 10px; color: var(--red); background: rgba(255,107,122,.08); border: 1px solid rgba(255,107,122,.35); }
.warn-box.iv { color: var(--accent2); background: rgba(255,209,102,.08); border-color: rgba(255,209,102,.35); }
@media (max-width: 900px) {
  .d-grid { grid-template-columns: 1fr; }
  .d-msgs { border-left: none; padding-left: 0; border-top: 1px solid var(--border); padding-top: 12px; }
}
</style>

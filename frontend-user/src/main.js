import { AudioAnalyzer } from './modules/audioAnalyzer.js';
import { ChartManager } from './modules/chartManager.js';
import { UIController } from './modules/uiController.js';
import { RecordManager } from './modules/recordManager.js';
import { Logger } from './utils/logger.js';

// 初始化日志
const logger = new Logger('Main');

// 应用初始化
class App {
  constructor() {
    this.audioAnalyzer = null;
    this.chartManager = null;
    this.uiController = null;
    this.recordManager = null;
    this.audioBuffer = null;
    this.audioContext = null;
    this.currentAnalysisResult = null;
    this.currentFileName = '';
    this.selectedRecordId = null;
    // 区间选择的已提交状态（唯一可信数据源），输入框内容可能暂时处于非法中间态
    this.range = { start: 0, end: 0, max: 0 };
    this.RANGE_STORAGE_KEY = 'guqin_audio_ranges';
  }

  async init() {
    logger.info('应用初始化开始');

    try {
      // 初始化 AudioContext
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      // 初始化模块
      this.audioAnalyzer = new AudioAnalyzer(this.audioContext);
      this.chartManager = new ChartManager();
      this.uiController = new UIController();
      this.recordManager = new RecordManager();

      // 绑定事件
      this.bindEvents();

      // 加载历史记录列表
      this.updateRecordsList();

      logger.info('应用初始化完成');
    } catch (error) {
      logger.error('应用初始化失败', error);
      alert('应用初始化失败，请刷新页面重试');
    }
  }

  bindEvents() {
    // 文件上传
    const uploadArea = document.getElementById('uploadArea');
    const audioInput = document.getElementById('audioInput');
    const removeFile = document.getElementById('removeFile');

    uploadArea.addEventListener('click', () => audioInput.click());
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) this.handleFileUpload(file);
    });

    audioInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.handleFileUpload(file);
    });

    removeFile.addEventListener('click', () => this.removeAudioFile());

    // 区间选择：输入框与滑块始终双向同步
    const startTime = document.getElementById('startTime');
    const endTime = document.getElementById('endTime');
    startTime.addEventListener('input', () => this.handleTimeInput('start'));
    endTime.addEventListener('input', () => this.handleTimeInput('end'));
    startTime.addEventListener('change', () => this.handleTimeInput('start'));
    endTime.addEventListener('change', () => this.handleTimeInput('end'));

    // 范围滑块拖拽（Pointer Events，同时支持鼠标 / 触摸 / 触控笔）
    this.initRangeSlider();

    // 分析按钮
    const analyzeBtn = document.getElementById('analyzeBtn');
    analyzeBtn.addEventListener('click', () => this.analyzeAudio());

    // 记录相关事件
    this.bindRecordEvents();
  }

  async handleFileUpload(file) {
    // 验证文件类型
    if (!file.type.startsWith('audio/')) {
      alert('请上传有效的音频文件');
      return;
    }

    this.currentFileName = file.name;
    logger.info('开始加载音频文件', { name: file.name, size: file.size });

    try {
      // 显示加载状态
      this.uiController.showLoading('正在加载音频...');

      // 读取文件
      const arrayBuffer = await file.arrayBuffer();
      
      // 解码音频
      this.audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      // 更新 UI
      const duration = this.audioBuffer.duration;
      const durationMs = Math.floor(duration * 1000);

      document.getElementById('fileName').textContent = file.name;
      document.getElementById('fileInfo').style.display = 'flex';
      document.getElementById('uploadArea').style.display = 'none';

      // 设置音频播放器
      const audioPlayer = document.getElementById('audioPlayer');
      audioPlayer.src = URL.createObjectURL(file);
      document.getElementById('audioPlayerSection').style.display = 'block';
      document.getElementById('totalDuration').textContent = duration.toFixed(3);

      // 设置区间选择（优先恢复上次在同一文件上选择的区间）
      const saved = this.loadSavedRange(file.name, durationMs);
      if (saved) {
        this.setRange(saved.start, saved.end, durationMs);
        this.uiController.showToast('已恢复上次选择的区间', 'info');
      } else {
        this.setRange(0, durationMs, durationMs);
      }

      // 启用分析按钮
      document.getElementById('analyzeBtn').disabled = false;

      logger.info('音频文件加载成功', { duration, sampleRate: this.audioBuffer.sampleRate });
    } catch (error) {
      logger.error('音频文件加载失败', error);
      alert('音频文件加载失败，请确保文件格式正确');
    } finally {
      this.uiController.hideLoading();
    }
  }

  removeAudioFile() {
    this.audioBuffer = null;
    this.currentAnalysisResult = null;
    this.currentFileName = '';
    document.getElementById('audioInput').value = '';
    document.getElementById('fileInfo').style.display = 'none';
    document.getElementById('uploadArea').style.display = 'block';
    document.getElementById('audioPlayerSection').style.display = 'none';
    document.getElementById('analyzeBtn').disabled = true;
    document.getElementById('chartContainer').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('fundamentalInfo').style.display = 'none';
    document.getElementById('saveRecordSection').style.display = 'none';

    // 重置区间选择状态（保存的区间仍保留在本地，下次上传同一文件时恢复）
    this.setRange(0, 0, 0);
    this.showRangeMessage('', 'info');
    document.getElementById('startTime').value = 0;
    document.getElementById('endTime').value = 0;
    
    // 清除图表
    this.chartManager.clearAllCharts();

    logger.info('音频文件已移除');
  }

  /**
   * 初始化区间滑杆
   * 使用 Pointer Events 统一处理鼠标与触摸；track 上的 touch-action:none
   * 保证触摸拖拽时页面不滚动。除拖动手柄外，也支持点击/点按轨道任意位置跳转。
   */
  initRangeSlider() {
    this.rangeTrack = document.getElementById('rangeTrack');
    this.handleStart = document.getElementById('handleStart');
    this.handleEnd = document.getElementById('handleEnd');
    this.rangeSliderContainer = document.getElementById('rangeSliderContainer');
    this.rangeMessageEl = document.getElementById('rangeMessage');

    // 按下手柄开始拖拽，或按在轨道上就近跳转
    this.rangeTrack.addEventListener('pointerdown', (e) => {
      if (!this.audioBuffer) return;
      e.preventDefault(); // 阻止触摸时的滚动/选中等默认行为

      let target;
      if (e.target === this.handleStart || this.handleStart.contains(e.target)) {
        target = 'start';
      } else if (e.target === this.handleEnd || this.handleEnd.contains(e.target)) {
        target = 'end';
      } else {
        // 点按轨道：选择距离更近的手柄
        target = this.nearestHandle(e.clientX);
        this.moveHandleTo(target, e.clientX, true);
      }

      this.dragging = target;
      this.handleStart.classList.toggle('dragging', target === 'start');
      this.handleEnd.classList.toggle('dragging', target === 'end');
      this.rangeTrack.setPointerCapture(e.pointerId);
    });

    this.rangeTrack.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      this.moveHandleTo(this.dragging, e.clientX, true);
    });

    const endDrag = (e) => {
      if (!this.dragging) return;
      if (this.rangeTrack.hasPointerCapture(e.pointerId)) {
        this.rangeTrack.releasePointerCapture(e.pointerId);
      }
      this.handleStart.classList.remove('dragging');
      this.handleEnd.classList.remove('dragging');
      this.dragging = null;
      // 清除拖拽中的瞬时位置提示
      if (this.rangeMessageEl.classList.contains('transient')) {
        this.showRangeMessage('', 'info');
      }
      this.persistRange();
    };
    this.rangeTrack.addEventListener('pointerup', endDrag);
    this.rangeTrack.addEventListener('pointercancel', endDrag);

    // 键盘可访问性：手柄聚焦后可用方向键微调
    this.handleStart.addEventListener('keydown', (e) => this.handleHandleKeydown('start', e));
    this.handleEnd.addEventListener('keydown', (e) => this.handleHandleKeydown('end', e));
  }

  /**
   * 找出距离指定横坐标更近的手柄
   */
  nearestHandle(clientX) {
    const rect = this.rangeTrack.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const startX = (this.range.start / this.range.max) * rect.width;
    const endX = (this.range.end / this.range.max) * rect.width;
    return Math.abs(x - startX) <= Math.abs(x - endX) ? 'start' : 'end';
  }

  /**
   * 将手柄移动到 clientX 对应的时间，不允许越过另一个手柄；
   * 被挡住（区间长度不足）时给出原因提示，而不是静默失败。
   * @param {boolean} live - 是否为拖拽/按键过程中的实时更新
   */
  moveHandleTo(which, clientX, live = false) {
    const rect = this.rangeTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const value = Math.round(ratio * this.range.max);
    return this.applyHandleValue(which, value, live);
  }

  /**
   * 手柄键盘操作：左右方向键 ±1ms，按住 Shift ±10ms（音频较长时步长按总时长放大）
   */
  handleHandleKeydown(which, e) {
    if (!this.audioBuffer) return;
    const stepKeys = ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!stepKeys.includes(e.key)) return;
    e.preventDefault();

    const current = which === 'start' ? this.range.start : this.range.end;
    // 音频较长时逐毫秒移动过于缓慢，步长随总时长自适应（约为总时长的千分之一）
    const step = Math.max(1, Math.round(this.range.max / 1000)) * (e.shiftKey ? 10 : 1);
    let value;
    if (e.key === 'Home') value = 0;
    else if (e.key === 'End') value = this.range.max;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') value = current - step;
    else value = current + step;

    value = Math.max(0, Math.min(this.range.max, value));
    if (this.applyHandleValue(which, value, true)) {
      // 键盘操作没有 pointerup，延时后清除瞬时位置提示
      clearTimeout(this._rangeMsgTimer);
      this._rangeMsgTimer = setTimeout(() => {
        if (this.rangeMessageEl.classList.contains('transient')) {
          this.showRangeMessage('', 'info');
        }
      }, 800);
      this.persistRange();
    }
  }

  /**
   * 尝试设置某个手柄的时间值（保证 start < end，最小间隔 1ms）
   * @returns {boolean} 是否接受了该值
   */
  applyHandleValue(which, value, live = false) {
    value = Math.max(0, Math.min(this.range.max, Math.round(value)));
    let nextStart = this.range.start;
    let nextEnd = this.range.end;

    if (which === 'start') {
      if (value >= nextEnd) {
        // 不越过结束手柄：吸附到 end-1 并说明原因
        const blocked = value !== this.range.start;
        nextStart = Math.max(0, nextEnd - 1);
        this.setRange(nextStart, nextEnd, this.range.max);
        if (blocked) {
          this.showRangeMessage(`起始时间不能晚于或等于结束时间（结束时间 ${nextEnd} ms），已吸附到最近的可用位置`, 'warning');
        }
        return false;
      }
      nextStart = value;
    } else {
      if (value <= nextStart) {
        const blocked = value !== this.range.end;
        nextEnd = Math.min(this.range.max, nextStart + 1);
        this.setRange(nextStart, nextEnd, this.range.max);
        if (blocked) {
          this.showRangeMessage(`结束时间不能早于或等于起始时间（起始时间 ${nextStart} ms），已吸附到最近的可用位置`, 'warning');
        }
        return false;
      }
      nextEnd = value;
    }

    this.setRange(nextStart, nextEnd, this.range.max);
    // 拖拽中只显示位置提示，松手后清空
    if (live) {
      const ms = which === 'start' ? nextStart : nextEnd;
      this.showRangeMessage(`${which === 'start' ? '起始' : '结束'}时间：${ms} ms`, 'info', true);
    }
    return true;
  }

  /**
   * 处理时间输入框：允许输入任意中间态，但只在合法时提交到滑块与徽标；
   * 非法时说明原因并保留用户内容以便重试，绝不悄悄改值。
   */
  handleTimeInput(which) {
    if (!this.audioBuffer) return;
    const input = document.getElementById(which === 'start' ? 'startTime' : 'endTime');
    const raw = input.value.trim();
    const otherInput = document.getElementById(which === 'start' ? 'endTime' : 'startTime');
    const otherCommitted = which === 'start' ? this.range.end : this.range.start;

    if (raw === '') {
      this.showRangeMessage(`请输入${which === 'start' ? '起始' : '结束'}时间（0 ~ ${this.range.max} ms）`, 'warning');
      this.setInputInvalid(input, true);
      this.updateAnalyzeButton();
      return;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      this.showRangeMessage('时间必须是整数毫秒，请重新输入', 'warning');
      this.setInputInvalid(input, true);
      this.updateAnalyzeButton();
      return;
    }

    if (value < 0 || value > this.range.max) {
      this.showRangeMessage(`${which === 'start' ? '起始' : '结束'}时间需在 0 ~ ${this.range.max} ms 之间`, 'warning');
      this.setInputInvalid(input, true);
      this.updateAnalyzeButton();
      return;
    }

    // 另一端输入框内容若处于非法中间态，用已提交状态做参照
    let otherValue = otherCommitted;
    const otherRaw = otherInput.value.trim();
    const otherParsed = Number(otherRaw);
    if (otherRaw !== '' && Number.isFinite(otherParsed) && Number.isInteger(otherParsed) &&
        otherParsed >= 0 && otherParsed <= this.range.max) {
      otherValue = otherParsed;
    }

    if (which === 'start' && value >= otherValue) {
      this.showRangeMessage(`起始时间需早于结束时间（当前结束 ${otherValue} ms），请重新输入`, 'warning');
      this.setInputInvalid(input, true);
      this.updateAnalyzeButton();
      return;
    }
    if (which === 'end' && value <= otherValue) {
      this.showRangeMessage(`结束时间需晚于起始时间（当前起始 ${otherValue} ms），请重新输入`, 'warning');
      this.setInputInvalid(input, true);
      this.updateAnalyzeButton();
      return;
    }

    // 合法：提交并与滑块、徽标同步
    this.setInputInvalid(input, false);
    if (which === 'start') {
      this.setRange(value, otherValue, this.range.max);
    } else {
      this.setRange(otherValue, value, this.range.max);
    }
    this.showRangeMessage('', 'info');
    this.persistRange();
  }

  setInputInvalid(input, invalid) {
    input.classList.toggle('invalid', invalid);
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  }

  /**
   * 设置区间状态并同步所有 UI（输入框、滑块、选中时长、分析按钮）
   */
  setRange(start, end, max) {
    this.range = {
      start: Math.round(start),
      end: Math.round(end),
      max: Math.round(max)
    };

    const startInput = document.getElementById('startTime');
    const endInput = document.getElementById('endTime');
    startInput.max = this.range.max;
    endInput.max = this.range.max;
    startInput.setAttribute('aria-valuemax', this.range.max);
    endInput.setAttribute('aria-valuemax', this.range.max);

    // 拖拽时输入框实时跟随；输入框聚焦时不覆盖用户正在编辑的内容
    if (document.activeElement !== startInput) startInput.value = this.range.start;
    if (document.activeElement !== endInput) endInput.value = this.range.end;

    this.renderRange();
    this.updateAnalyzeButton();
  }

  /**
   * 根据当前状态渲染滑块位置、选中时长与无障碍属性
   */
  renderRange() {
    const { start, end, max } = this.range;
    const startPercent = max > 0 ? (start / max) * 100 : 0;
    const endPercent = max > 0 ? (end / max) * 100 : 0;

    this.handleStart.style.left = `${startPercent}%`;
    this.handleEnd.style.left = `${endPercent}%`;
    document.getElementById('rangeSelected').style.left = `${startPercent}%`;
    document.getElementById('rangeSelected').style.width = `${Math.max(0, endPercent - startPercent)}%`;

    this.handleStart.setAttribute('aria-valuemax', String(max));
    this.handleEnd.setAttribute('aria-valuemax', String(max));
    this.handleStart.setAttribute('aria-valuenow', String(start));
    this.handleEnd.setAttribute('aria-valuenow', String(end));
    this.handleStart.setAttribute('aria-valuetext', `${start} 毫秒`);
    this.handleEnd.setAttribute('aria-valuetext', `${end} 毫秒`);

    // 选中时长始终来自已提交的合法状态，不会与滑块/输入框不一致
    const durationSec = Math.max(0, end - start) / 1000;
    document.getElementById('selectedDuration').textContent = durationSec.toFixed(3);
  }

  /**
   * 校验当前已提交区间是否可用于分析
   */
  isRangeValid() {
    return this.audioBuffer &&
      this.range.max > 0 &&
      Number.isInteger(this.range.start) &&
      Number.isInteger(this.range.end) &&
      this.range.start >= 0 &&
      this.range.end <= this.range.max &&
      this.range.start < this.range.end;
  }

  updateAnalyzeButton() {
    document.getElementById('analyzeBtn').disabled = !this.isRangeValid();
  }

  /**
   * 在滑杆下方显示行内提示（错误原因 / 拖拽位置）
   * @param {boolean} transient - 瞬时提示（拖拽中），松手时自动清除
   */
  showRangeMessage(message, type = 'info', transient = false) {
    const el = this.rangeMessageEl;
    if (!el) return;
    el.textContent = message;
    el.dataset.type = message ? type : '';
    el.classList.toggle('visible', Boolean(message));
    el.classList.toggle('transient', transient);
  }

  /**
   * 持久化当前区间到 localStorage（按文件名分别保存最近的若干个）
   */
  persistRange() {
    if (!this.currentFileName || !this.isRangeValid()) return;
    try {
      const data = JSON.parse(localStorage.getItem(this.RANGE_STORAGE_KEY) || '{}');
      data[this.currentFileName] = {
        start: this.range.start,
        end: this.range.end,
        max: this.range.max,
        savedAt: Date.now()
      };
      // 只保留最近 20 个文件的区间
      const entries = Object.entries(data).sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
      const trimmed = Object.fromEntries(entries.slice(0, 20));
      localStorage.setItem(this.RANGE_STORAGE_KEY, JSON.stringify(trimmed));
    } catch (error) {
      logger.warn('区间保存失败', error);
    }
  }

  /**
   * 读取该文件上次保存的区间，并校验在当前音频时长下仍然合法
   */
  loadSavedRange(fileName, durationMs) {
    try {
      const data = JSON.parse(localStorage.getItem(this.RANGE_STORAGE_KEY) || '{}');
      const saved = data[fileName];
      if (!saved) return null;
      // 同名但不同时长（可能是不同音频）的记录不可用
      if (saved.max !== durationMs) return null;
      if (saved.start >= 0 && saved.end <= durationMs && saved.start < saved.end) {
        return { start: saved.start, end: saved.end };
      }
    } catch (error) {
      logger.warn('区间恢复失败', error);
    }
    return null;
  }

  async analyzeAudio() {
    if (!this.audioBuffer) {
      alert('请先上传音频文件');
      return;
    }

    if (!this.isRangeValid()) {
      this.showRangeMessage('当前区间无效：起始时间需小于结束时间且在音频时长范围内，请修正后重试', 'warning');
      return;
    }

    const startMs = this.range.start;
    const endMs = this.range.end;

    logger.info('开始分析音频', { startMs, endMs });

    try {
      this.uiController.showLoading('正在分析音频...');

      // 获取 FFT 大小
      const fftSize = parseInt(document.getElementById('fftSize').value);

      // 提取选定区间的音频数据
      const startSample = Math.floor((startMs / 1000) * this.audioBuffer.sampleRate);
      const endSample = Math.floor((endMs / 1000) * this.audioBuffer.sampleRate);
      const channelData = this.audioBuffer.getChannelData(0);
      const selectedData = channelData.slice(startSample, endSample);

      // 分析音频
      const analysisResult = await this.audioAnalyzer.analyze(selectedData, this.audioBuffer.sampleRate, fftSize);

      logger.info('音频分析完成', { 
        fundamentalFreq: analysisResult.fundamentalFreq,
        harmonicsCount: analysisResult.harmonics.length 
      });

      // 保存当前分析结果
      this.currentAnalysisResult = analysisResult;

      // 更新图表
      this.chartManager.updateAllCharts(analysisResult, selectedData, this.audioBuffer.sampleRate);

      // 更新基频信息
      this.updateFundamentalInfo(analysisResult);

      // 显示图表区域
      document.getElementById('chartContainer').style.display = 'flex';
      document.getElementById('emptyState').style.display = 'none';

      // 显示保存记录区域
      document.getElementById('saveRecordSection').style.display = 'block';
      document.getElementById('recordName').value = `${this.currentFileName} - ${this.recordManager.formatTimestamp()}`;
      document.getElementById('recordNote').value = '';

    } catch (error) {
      logger.error('音频分析失败', error);
      alert('音频分析失败: ' + error.message);
    } finally {
      this.uiController.hideLoading();
    }
  }

  updateFundamentalInfo(result) {
    document.getElementById('fundamentalInfo').style.display = 'block';
    document.getElementById('fundamentalFreq').textContent = result.fundamentalFreq.toFixed(2);

    const harmonicsList = document.getElementById('harmonicsList');
    harmonicsList.innerHTML = result.harmonics.map((h, i) => `
      <div class="harmonic-item">
        <span class="harmonic-label">${i + 2}倍频</span>
        <span class="harmonic-freq">${h.toFixed(1)} Hz</span>
      </div>
    `).join('');
  }

  bindRecordEvents() {
    // 保存记录按钮
    document.getElementById('saveRecordBtn').addEventListener('click', () => this.saveRecord());

    // 展开/收起记录列表
    document.getElementById('toggleRecordsBtn').addEventListener('click', () => this.toggleRecordsPanel());

    // 关闭模态框
    document.getElementById('closeModalBtn').addEventListener('click', () => this.closeRecordModal());
    document.getElementById('recordDetailModal').addEventListener('click', (e) => {
      if (e.target.id === 'recordDetailModal') {
        this.closeRecordModal();
      }
    });

    // 应用记录
    document.getElementById('applyRecordBtn').addEventListener('click', () => this.applyRecord());

    // 删除记录
    document.getElementById('deleteRecordBtn').addEventListener('click', () => this.deleteRecord());
  }

  saveRecord() {
    if (!this.currentAnalysisResult) {
      this.uiController.showToast('没有可保存的分析结果', 'warning');
      return;
    }

    const name = document.getElementById('recordName').value.trim();
    const note = document.getElementById('recordNote').value.trim();
    const startMs = this.range.start;
    const endMs = this.range.end;

    const harmonicIntensities = this.extractHarmonicIntensities(this.currentAnalysisResult);

    try {
      const record = this.recordManager.createRecord({
        fileName: this.currentFileName,
        startMs,
        endMs,
        fundamentalFreq: this.currentAnalysisResult.fundamentalFreq,
        harmonics: this.currentAnalysisResult.harmonics,
        harmonicIntensities,
        analysisResult: this.currentAnalysisResult,
        name: name
      });

      if (note) {
        this.recordManager.updateRecord(record.id, { note });
      }

      this.uiController.showToast('记录保存成功', 'success');
      this.updateRecordsList();
    } catch (error) {
      this.uiController.showToast(error.message, 'error');
    }
  }

  extractHarmonicIntensities(analysisResult) {
    const { fundamentalFreq, harmonics, frequencies, magnitudes } = analysisResult;
    const allHarmonics = [fundamentalFreq, ...harmonics];
    const intensities = {};

    allHarmonics.forEach((harmonic, index) => {
      let closestMag = 0;
      let minDist = Infinity;

      for (let i = 0; i < frequencies.length; i++) {
        const dist = Math.abs(frequencies[i] - harmonic);
        if (dist < minDist) {
          minDist = dist;
          closestMag = magnitudes[i];
        }
      }

      const key = index === 0 ? 'fundamental' : `harmonic${index + 1}`;
      intensities[key] = closestMag;
    });

    const maxMag = Math.max(...Object.values(intensities));
    const normalizedIntensities = {};
    Object.keys(intensities).forEach(key => {
      normalizedIntensities[key] = maxMag > 0 ? (intensities[key] / maxMag) * 100 : 0;
    });

    return normalizedIntensities;
  }

  updateRecordsList() {
    const records = this.recordManager.getAllRecords();
    const recordsList = document.getElementById('recordsList');
    const recordsEmpty = document.getElementById('recordsEmpty');

    if (records.length === 0) {
      recordsList.style.display = 'none';
      recordsEmpty.style.display = 'flex';
      return;
    }

    recordsList.style.display = 'block';
    recordsEmpty.style.display = 'none';

    recordsList.innerHTML = records.map(record => `
      <div class="record-item" data-id="${record.id}">
        <div class="record-main">
          <span class="record-name" title="${record.name}">${this.truncateText(record.name, 25)}</span>
          <span class="record-freq">${record.fundamentalFreq.toFixed(1)} Hz</span>
        </div>
        <div class="record-meta">
          <span class="record-file" title="${record.fileName}">${this.truncateText(record.fileName, 20)}</span>
          <span class="record-time">${this.recordManager.formatDate(record.createdAt)}</span>
        </div>
      </div>
    `).join('');

    recordsList.querySelectorAll('.record-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        this.showRecordDetail(id);
      });
    });
  }

  truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  toggleRecordsPanel() {
    const content = document.getElementById('recordsContent');
    const btn = document.getElementById('toggleRecordsBtn');
    
    if (content.style.display === 'none') {
      content.style.display = 'block';
      btn.textContent = '▼';
    } else {
      content.style.display = 'none';
      btn.textContent = '▶';
    }
  }

  showRecordDetail(recordId) {
    const record = this.recordManager.getRecord(recordId);
    if (!record) return;

    this.selectedRecordId = recordId;

    const modalBody = document.getElementById('modalBody');
    document.getElementById('modalTitle').textContent = record.name;

    modalBody.innerHTML = `
      <div class="record-detail">
        <div class="detail-section">
          <h4>基本信息</h4>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">文件名</span>
              <span class="detail-value">${record.fileName}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">创建时间</span>
              <span class="detail-value">${this.recordManager.formatTimestampFull(record.createdAt)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">分析区间</span>
              <span class="detail-value">${record.startMs}ms - ${record.endMs}ms (${(record.durationMs / 1000).toFixed(3)}s)</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">基频</span>
              <span class="detail-value highlight">${record.fundamentalFreq.toFixed(2)} Hz</span>
            </div>
          </div>
        </div>
        
        <div class="detail-section">
          <h4>倍频与强度</h4>
          <div class="harmonics-table">
            <div class="table-header">
              <span>谐波</span>
              <span>频率</span>
              <span>相对强度</span>
            </div>
            <div class="table-row">
              <span>基频</span>
              <span>${record.fundamentalFreq.toFixed(1)} Hz</span>
              <span>
                <div class="intensity-bar">
                  <div class="intensity-fill" style="width: ${record.harmonicIntensities?.fundamental || 100}%"></div>
                  <span class="intensity-text">${(record.harmonicIntensities?.fundamental || 100).toFixed(1)}%</span>
                </div>
              </span>
            </div>
            ${record.harmonics.map((h, i) => {
              const intensityKey = `harmonic${i + 2}`;
              const intensity = record.harmonicIntensities?.[intensityKey] || 0;
              return `
                <div class="table-row">
                  <span>${i + 2}倍频</span>
                  <span>${h.toFixed(1)} Hz</span>
                  <span>
                    <div class="intensity-bar">
                      <div class="intensity-fill" style="width: ${intensity}%"></div>
                      <span class="intensity-text">${intensity.toFixed(1)}%</span>
                    </div>
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        
        ${record.note ? `
          <div class="detail-section">
            <h4>备注</h4>
            <p class="record-note">${record.note}</p>
          </div>
        ` : ''}
      </div>
    `;

    document.getElementById('recordDetailModal').style.display = 'flex';
  }

  closeRecordModal() {
    document.getElementById('recordDetailModal').style.display = 'none';
    this.selectedRecordId = null;
  }

  applyRecord() {
    if (!this.selectedRecordId) return;

    const record = this.recordManager.getRecord(this.selectedRecordId);
    if (!record) return;

    if (!record.analysisResult) {
      this.uiController.showToast('该记录不包含完整的分析数据', 'warning');
      return;
    }

    this.currentAnalysisResult = record.analysisResult;

    const fakeAudioData = new Float32Array(1000).fill(0);
    const sampleRate = 44100;
    this.chartManager.updateAllCharts(record.analysisResult, fakeAudioData, sampleRate);
    this.updateFundamentalInfo(record.analysisResult);

    document.getElementById('chartContainer').style.display = 'flex';
    document.getElementById('emptyState').style.display = 'none';

    this.closeRecordModal();
    this.uiController.showToast('记录已应用', 'success');
  }

  deleteRecord() {
    if (!this.selectedRecordId) return;

    if (confirm('确定要删除这条记录吗？此操作不可恢复。')) {
      const success = this.recordManager.deleteRecord(this.selectedRecordId);
      if (success) {
        this.updateRecordsList();
        this.closeRecordModal();
        this.uiController.showToast('记录已删除', 'success');
      } else {
        this.uiController.showToast('删除失败', 'error');
      }
    }
  }
}

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});

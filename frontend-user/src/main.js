import { AudioAnalyzer } from './modules/audioAnalyzer.js';
import { ChartManager } from './modules/chartManager.js';
import { UIController } from './modules/uiController.js';
import { RecordManager } from './modules/recordManager.js';
import { Logger } from './utils/logger.js';

// 初始化日志
const logger = new Logger('Main');

// 应用初始化
export class App {
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
    this.currentDurationMs = 0;
    this.lastValidRange = { start: 0, end: 0 };
    this.RANGE_STORAGE_KEY = 'guqin_range_selection';
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

    // 区间选择
    const startTime = document.getElementById('startTime');
    const endTime = document.getElementById('endTime');
    // 输入过程中实时渲染滑块（不打断输入），编辑完成后再严格校验
    startTime.addEventListener('input', () => this.updateRangeSlider());
    endTime.addEventListener('input', () => this.updateRangeSlider());
    startTime.addEventListener('change', () => this.handleRangeInputChange());
    endTime.addEventListener('change', () => this.handleRangeInputChange());

    // 范围滑块拖拽
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

      // 设置区间选择
      this.currentDurationMs = durationMs;
      const startInput = document.getElementById('startTime');
      const endInput = document.getElementById('endTime');
      startInput.max = durationMs;
      endInput.max = durationMs;

      // 优先恢复上次保存的区间，否则默认选中整个音频
      if (!this.restoreRangeSelection()) {
        startInput.value = 0;
        endInput.value = durationMs;
      }

      this.updateRangeSlider();
      this.persistRangeSelection();

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
    this.currentDurationMs = 0;
    this.lastValidRange = { start: 0, end: 0 };
    document.getElementById('audioInput').value = '';
    document.getElementById('fileInfo').style.display = 'none';
    document.getElementById('uploadArea').style.display = 'block';
    document.getElementById('audioPlayerSection').style.display = 'none';
    document.getElementById('analyzeBtn').disabled = true;
    document.getElementById('chartContainer').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('fundamentalInfo').style.display = 'none';
    document.getElementById('saveRecordSection').style.display = 'none';

    // 重置区间选择 UI（保留 localStorage 中的记录，重新上传同一文件时仍可恢复）
    const startInput = document.getElementById('startTime');
    const endInput = document.getElementById('endTime');
    startInput.value = 0;
    endInput.value = 0;
    startInput.removeAttribute('max');
    endInput.removeAttribute('max');
    this.updateRangeSlider();

    // 清除图表
    this.chartManager.clearAllCharts();

    logger.info('音频文件已移除');
  }

  initRangeSlider() {
    const track = document.getElementById('rangeTrack');
    const handleStart = document.getElementById('handleStart');
    const handleEnd = document.getElementById('handleEnd');
    let isDragging = null;

    const getMaxMs = () => parseInt(document.getElementById('endTime').max) || 1000;

    const getClientX = (e) => {
      if (e.touches && e.touches.length) return e.touches[0].clientX;
      if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientX;
      return e.clientX;
    };

    const updateFromSlider = (clientX) => {
      const rect = track.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const maxMs = getMaxMs();
      const value = Math.round(percent * maxMs);

      if (isDragging === 'start') {
        const endValue = parseInt(document.getElementById('endTime').value) || 0;
        document.getElementById('startTime').value = Math.max(0, Math.min(value, endValue - 1));
      } else if (isDragging === 'end') {
        const startValue = parseInt(document.getElementById('startTime').value) || 0;
        document.getElementById('endTime').value = Math.min(maxMs, Math.max(value, startValue + 1));
      }

      this.updateRangeSlider();
    };

    // 点击轨道空白处时，移动距离点击位置较近的手柄
    const nearestHandle = (clientX) => {
      const rect = track.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const maxMs = getMaxMs();
      const startPercent = (parseInt(document.getElementById('startTime').value) || 0) / maxMs;
      const endPercent = (parseInt(document.getElementById('endTime').value) || 0) / maxMs;
      return Math.abs(percent - startPercent) <= Math.abs(percent - endPercent) ? 'start' : 'end';
    };

    const beginDrag = (handle, e) => {
      if (!this.audioBuffer) {
        this.uiController.showToast('请先上传音频文件，再拖动选择区间', 'warning');
        return;
      }
      isDragging = handle;
      document.body.classList.add('range-dragging');
      if (e.cancelable) e.preventDefault();
      updateFromSlider(getClientX(e));
    };

    const moveDrag = (e) => {
      if (!isDragging) return;
      if (e.cancelable) e.preventDefault();
      updateFromSlider(getClientX(e));
    };

    const endDrag = () => {
      if (!isDragging) return;
      isDragging = null;
      document.body.classList.remove('range-dragging');
      this.persistRangeSelection();
    };

    const bindHandle = (handle, name) => {
      if (window.PointerEvent) {
        handle.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          beginDrag(name, e);
        });
      } else {
        handle.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          beginDrag(name, e);
        });
        // passive: false 才能 preventDefault，阻止拖动时页面滚动
        handle.addEventListener('touchstart', (e) => {
          e.stopPropagation();
          beginDrag(name, e);
        }, { passive: false });
      }
    };

    bindHandle(handleStart, 'start');
    bindHandle(handleEnd, 'end');

    if (window.PointerEvent) {
      track.addEventListener('pointerdown', (e) => beginDrag(nearestHandle(getClientX(e)), e));
      document.addEventListener('pointermove', moveDrag);
      document.addEventListener('pointerup', endDrag);
      document.addEventListener('pointercancel', endDrag);
    } else {
      track.addEventListener('mousedown', (e) => beginDrag(nearestHandle(getClientX(e)), e));
      document.addEventListener('mousemove', moveDrag);
      document.addEventListener('mouseup', endDrag);

      track.addEventListener('touchstart', (e) => beginDrag(nearestHandle(getClientX(e)), e), { passive: false });
      document.addEventListener('touchmove', moveDrag, { passive: false });
      document.addEventListener('touchend', endDrag);
      document.addEventListener('touchcancel', endDrag);
    }
  }

  /**
   * 根据输入框当前值渲染滑块位置与选中时长。
   * 只读取不篡改输入框，滑块、选中区、时长显示始终与输入框数字一致；
   * 区间合法时记录为最近有效值，供校验失败时恢复。
   */
  updateRangeSlider() {
    const startInput = document.getElementById('startTime');
    const endInput = document.getElementById('endTime');
    const maxTime = parseInt(endInput.max) || 1000;

    let startTime = parseInt(startInput.value);
    let endTime = parseInt(endInput.value);
    // 输入中途（如清空输入框）无法解析时，按最近有效值渲染，不打扰输入
    if (isNaN(startTime)) startTime = this.lastValidRange.start;
    if (isNaN(endTime)) endTime = this.lastValidRange.end;

    const startPercent = Math.max(0, Math.min(100, (startTime / maxTime) * 100));
    const endPercent = Math.max(0, Math.min(100, (endTime / maxTime) * 100));

    document.getElementById('handleStart').style.left = `${startPercent}%`;
    document.getElementById('handleEnd').style.left = `${endPercent}%`;

    const selected = document.getElementById('rangeSelected');
    selected.style.left = `${Math.min(startPercent, endPercent)}%`;
    selected.style.width = `${Math.abs(endPercent - startPercent)}%`;

    const durationSec = Math.max(0, endTime - startTime) / 1000;
    document.getElementById('selectedDuration').textContent = durationSec.toFixed(3);

    if (startTime >= 0 && endTime <= maxTime && startTime < endTime) {
      this.lastValidRange = { start: startTime, end: endTime };
    }
  }

  /**
   * 校验区间输入，返回错误原因；合法时返回 null
   */
  validateRangeInput(startTime, endTime, maxTime) {
    if (isNaN(startTime) || isNaN(endTime)) {
      return '请输入有效的数字（单位：毫秒）';
    }
    if (startTime < 0 || endTime < 0) {
      return '时间不能为负数，请输入 0 以上的数值';
    }
    if (startTime > maxTime || endTime > maxTime) {
      return `超出音频时长范围，请输入 0 ~ ${maxTime} ms 之间的数值`;
    }
    if (startTime >= endTime) {
      return '起始时间必须小于结束时间';
    }
    return null;
  }

  /**
   * 输入框编辑完成时校验区间：非法则说明原因并恢复为最近有效值，允许重新输入
   */
  handleRangeInputChange() {
    const startInput = document.getElementById('startTime');
    const endInput = document.getElementById('endTime');
    const maxTime = parseInt(endInput.max) || 1000;

    const error = this.validateRangeInput(
      parseInt(startInput.value),
      parseInt(endInput.value),
      maxTime
    );

    if (error) {
      this.uiController.showToast(`${error}，已恢复为之前的有效区间`, 'warning');
      startInput.value = this.lastValidRange.start;
      endInput.value = this.lastValidRange.end;
      this.updateRangeSlider();
      return;
    }

    this.updateRangeSlider();
    this.persistRangeSelection();
  }

  /**
   * 将当前区间选择保存到 localStorage，重新打开页面后可恢复
   */
  persistRangeSelection() {
    if (!this.currentFileName) return;
    try {
      const data = {
        fileName: this.currentFileName,
        durationMs: this.currentDurationMs,
        startMs: this.lastValidRange.start,
        endMs: this.lastValidRange.end
      };
      localStorage.setItem(this.RANGE_STORAGE_KEY, JSON.stringify(data));
      logger.info('区间选择已保存', data);
    } catch (error) {
      logger.error('保存区间选择失败', error);
    }
  }

  /**
   * 恢复当前音频文件上次的区间选择
   * @returns {boolean} 是否成功恢复
   */
  restoreRangeSelection() {
    try {
      const data = localStorage.getItem(this.RANGE_STORAGE_KEY);
      if (!data) return false;

      const saved = JSON.parse(data);
      // 仅当文件名相同且音频时长基本一致时才恢复，避免套用到其他音频上
      if (saved.fileName !== this.currentFileName) return false;
      if (Math.abs(saved.durationMs - this.currentDurationMs) > 1000) return false;

      const startMs = Math.max(0, Math.min(saved.startMs, this.currentDurationMs));
      const endMs = Math.max(0, Math.min(saved.endMs, this.currentDurationMs));
      if (this.validateRangeInput(startMs, endMs, this.currentDurationMs)) return false;

      document.getElementById('startTime').value = startMs;
      document.getElementById('endTime').value = endMs;
      logger.info('已恢复上次的区间选择', { startMs, endMs });
      return true;
    } catch (error) {
      logger.error('恢复区间选择失败', error);
      return false;
    }
  }

  async analyzeAudio() {
    if (!this.audioBuffer) {
      alert('请先上传音频文件');
      return;
    }

    const startMs = parseInt(document.getElementById('startTime').value);
    const endMs = parseInt(document.getElementById('endTime').value);

    const rangeError = this.validateRangeInput(startMs, endMs, this.currentDurationMs);
    if (rangeError) {
      this.uiController.showToast(`无法分析：${rangeError}`, 'error');
      return;
    }

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
    const startMs = parseInt(document.getElementById('startTime').value) || 0;
    const endMs = parseInt(document.getElementById('endTime').value) || 0;

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

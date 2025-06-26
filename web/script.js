class CameraController {
    constructor() {
        this.baseUrl = window.location.origin;
        this.isStreaming = false;
        this.currentProtocol = 'hls';
        this.hls = null;
        this.updateInterval = null;
        
        // 节流控制
        this.servoThrottle = null;
        this.lastServoCall = 0;
        this.servoCallDelay = 200;
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupKeyboardControls();
        this.startStatusUpdates();
        this.loadInitialData();
    }

    // API调用方法
    async apiCall(endpoint, method = 'GET', data = null) {
        try {
            const options = {
                method,
                headers: {
                    'Content-Type': 'application/json',
                }
            };
            
            if (data) {
                options.body = JSON.stringify(data);
            }
            
            const response = await fetch(`${this.baseUrl}${endpoint}`, options);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // 检查响应内容类型
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
                return await response.json();
            } else {
                // 对于非JSON响应，返回文本
                const text = await response.text();
                return { status: 'ok', data: text };
            }
        } catch (error) {
            console.error(`API call failed: ${endpoint}`, error);
            this.showToast('error', '网络错误', `请求失败: ${error.message}`);
            throw error;
        }
    }

    // 初始化数据加载
    async loadInitialData() {
        try {
            // 更新连接状态
            this.updateConnectionStatus(true);
            
            // 加载系统信息
            await this.updateSystemInfo();
            
            // 加载电源状态
            await this.updatePowerStatus();
            
            // 加载角度状态
            await this.updateServoPositions();
            
            // 加载舵机限位
            await this.updateServoLimits();
            
            this.showToast('success', '连接成功', '设备已连接');
        } catch (error) {
            this.updateConnectionStatus(false);
            this.showToast('error', '连接失败', '无法连接到设备');
        }
    }

    // 设置事件监听器
    setupEventListeners() {
        // 流媒体控制
        document.getElementById('stream-toggle').addEventListener('click', () => {
            this.toggleStream();
        });

        document.getElementById('protocol-select').addEventListener('change', (e) => {
            this.currentProtocol = e.target.value;
            this.updateUrlGroup();
        });

        // 电源按钮点击
        document.getElementById('power-button').addEventListener('click', () => {
            this.togglePower();
        });

        // 角度控制
        document.getElementById('pan-slider').addEventListener('input', (e) => {
            this.updateSliderValue('pan', e.target.value);
        });

        document.getElementById('tilt-slider').addEventListener('input', (e) => {
            this.updateSliderValue('tilt', e.target.value);
        });

        document.getElementById('pan-slider').addEventListener('change', (e) => {
            this.setServoAngle('pan', parseInt(e.target.value));
        });

        document.getElementById('tilt-slider').addEventListener('change', (e) => {
            this.setServoAngle('tilt', parseInt(e.target.value));
        });

        // 角度按钮（相对运动实现）
        document.querySelectorAll('.angle-buttons .btn').forEach(btn => {
            btn.addEventListener('mousedown', (e) => {
                const button = e.target.closest('.btn');
                const axis = button.dataset.axis;
                const angleDelta = parseFloat(button.dataset.angle);
                if (angleDelta === 0) {
                    // 回中心
                    this.setServoAngle(axis, 0);
                    // 同步slider
                    document.getElementById(`${axis}-slider`).value = 0;
                    this.updateSliderValue(axis, 0);
                } else {
                    // 相对运动
                    const slider = document.getElementById(`${axis}-slider`);
                    let current = parseInt(slider.value);
                    let next = current + angleDelta;
                    // 限制范围
                    next = Math.max(parseInt(slider.min), Math.min(parseInt(slider.max), next));
                    this.setServoAngle(axis, next);
                    slider.value = next;
                    this.updateSliderValue(axis, next);
                }
            });
        });

        // 重启按钮
        document.getElementById('reboot-button').addEventListener('click', () => {
            this.rebootSystem();
        });
        document.getElementById('hostname-edit').addEventListener('click', () => {
            this.toggleHostnameEdit();
        });

        // 舵机限位设置
        document.getElementById('pan-limit-set').addEventListener('click', () => {
            this.setServoLimits('pan');
        });

        document.getElementById('tilt-limit-set').addEventListener('click', () => {
            this.setServoLimits('tilt');
        });

        // 视频覆盖层点击
        document.getElementById('video-overlay').addEventListener('click', () => {
            this.toggleStream();
        });

        // 协议选择更新
        this.updateUrlGroup();
    }

    // 键盘控制
    setupKeyboardControls() {
        let pressedKeys = new Set();
        
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT') return;
            
            pressedKeys.add(e.key.toLowerCase());
            
            switch (e.key.toLowerCase()) {
                case 'h':
                    this.toggleKeyboardHelp();
                    break;
                case 'p':
                    this.togglePower();
                    break;
                case 'enter':
                    this.toggleStream();
                    break;
                case ' ':
                    e.preventDefault();
                    this.centerServos();
                    break;
            }
        });

        document.addEventListener('keyup', (e) => {
            pressedKeys.delete(e.key.toLowerCase());
        });

        // 连续按键控制
        setInterval(() => {
            let panDelta = 0;
            let tiltDelta = 0;
            
            if (pressedKeys.has('a')) panDelta -= 2;
            if (pressedKeys.has('d')) panDelta += 2;
            if (pressedKeys.has('w')) tiltDelta += 2;
            if (pressedKeys.has('s')) tiltDelta -= 2;
            
            if (panDelta !== 0 || tiltDelta !== 0) {
                this.throttledServoAdjust(panDelta, tiltDelta);
            }
        }, 100);
    }

    // 状态更新
    startStatusUpdates() {
        this.updateInterval = setInterval(async () => {
            try {
                await this.updateSystemInfo();
                await this.updateTemperature();
                await this.updateServoPositions(); // 新增：周期性刷新实际角度
                await this.updateStreamStatus(); // 新增：同步流状态
            } catch (error) {
                console.error('Status update failed:', error);
                this.updateConnectionStatus(false);
            }
        }, 1000); // 增加到10秒更新一次，减少频率
    }

    // 流媒体控制
    async toggleStream() {
        if (this.isStreaming) {
            await this.stopStream();
        } else {
            await this.startStream();
        }
    }

    async startStream() {
        try {
            const protocol = this.currentProtocol;
            const view = document.getElementById('view-select').value;
            let url = '';
            
            if (protocol === 'udp') {
                url = document.getElementById('url-input').value || 'udp://192.168.1.100:5000';
            }
            
            // 先显示正在启动的状态
            this.isStreaming = true;
            this.updateStreamButton();
            document.getElementById('video-overlay').classList.add('hidden');
            this.showToast('info', '正在启动', `${protocol.toUpperCase()} 流正在准备中...`);
            
            const response = await this.apiCall(`/stream/${protocol}`, 'POST', {
                on: true,
                view: view,
                url: url
            });
            
            if (protocol === 'hls' && response.url) {
                // HLS需要等待一段时间让流准备好
                this.showToast('info', '准备中', 'HLS流正在初始化，请稍候...');
                setTimeout(() => {
                    this.setupHLSPlayer(response.url);
                    this.showToast('success', '直播已开始', 'HLS 流已启动');
                }, 3000); // 等待3秒让流准备好
            } else if (protocol === 'rtsp' && response.url) {
                this.setupRTSPPlayer(response.url);
                this.showToast('success', '直播已开始', 'RTSP 流已启动');
            } else {
                this.showToast('success', '直播已开始', `${protocol.toUpperCase()} 流已启动`);
            }
            
        } catch (error) {
            console.error('Start stream failed:', error);
            this.isStreaming = false;
            this.updateStreamButton();
            document.getElementById('video-overlay').classList.remove('hidden');
            this.showToast('error', '直播启动失败', error.message);
        }
    }

    async stopStream() {
        try {
            await this.apiCall(`/stream/${this.currentProtocol}`, 'POST', { on: false });
            
            this.isStreaming = false;
            this.updateStreamButton();
            this.destroyPlayer();
            
            document.getElementById('video-overlay').classList.remove('hidden');
            this.showToast('info', '直播已停止', '流媒体已关闭');
            
        } catch (error) {
            console.error('Stop stream failed:', error);
            this.showToast('error', '停止直播失败', error.message);
        }
    }

    setupHLSPlayer(url) {
        const video = document.getElementById('video-player');
        
        if (Hls.isSupported()) {
            if (this.hls) {
                this.hls.destroy();
            }
            
            this.hls = new Hls({
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 5,
                enableWorker: true,
                lowLatencyMode: true,
            });
            
            this.hls.loadSource(url);
            this.hls.attachMedia(video);
            
            this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().catch(e => console.warn('Autoplay prevented:', e));
            });
            
            this.hls.on(Hls.Events.ERROR, (event, data) => {
                console.error('HLS error:', data);
                if (data.fatal) {
                    this.showToast('error', 'HLS错误', '播放器出现致命错误');
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            video.addEventListener('loadedmetadata', () => {
                video.play().catch(e => console.warn('Autoplay prevented:', e));
            });
        }
    }

    setupRTSPPlayer(url) {
        // RTSP通常需要特殊处理，这里显示URL供用户使用
        this.showToast('info', 'RTSP流已启动', `请使用支持RTSP的播放器打开: ${url}`);
    }

    destroyPlayer() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        
        const video = document.getElementById('video-player');
        video.pause();
        video.src = '';
        video.load();
    }

    updateStreamButton() {
        const button = document.getElementById('stream-toggle');
        
        if (this.isStreaming) {
            button.innerHTML = '<i class="fas fa-stop"></i>停止直播';
            button.className = 'btn btn-primary btn-stop';
        } else {
            button.innerHTML = '<i class="fas fa-play"></i>开始直播';
            button.className = 'btn btn-primary';
        }
    }

    updateUrlGroup() {
        const urlGroup = document.getElementById('url-group');
        if (this.currentProtocol === 'udp') {
            urlGroup.classList.add('show');
            // 自动填充访问者IP到自定义URL
            const urlInput = document.getElementById('url-input');
            // 仅在输入框为空时自动填充，避免覆盖用户手动输入
            if (!urlInput.value) {
                fetch('/system/client_ip').then(r => r.json()).then(res => {
                    if (res && res.ip) {
                        urlInput.value = `udp://${res.ip}:5000`;
                    }
                }).catch(() => {
                    // 客户端IP获取失败时使用默认值
                    urlInput.value = 'udp://192.168.1.100:5000';
                });
            }
        } else {
            urlGroup.classList.remove('show');
        }
    }

    // 更新流状态（用于多设备同步）
    async updateStreamStatus() {
        try {
            const response = await this.apiCall(`/stream/${this.currentProtocol}`, 'GET');
            const serverStreaming = response.on;
            
            // 如果服务器状态与客户端状态不一致，同步客户端状态
            if (serverStreaming !== this.isStreaming) {
                this.isStreaming = serverStreaming;
                this.updateStreamButton();
                
                // 更新视频覆盖层
                const videoOverlay = document.getElementById('video-overlay');
                if (this.isStreaming) {
                    videoOverlay.classList.add('hidden');
                    // 如果是HLS，重新设置播放器
                    if (this.currentProtocol === 'hls' && response.url) {
                        this.setupHLSPlayer(response.url);
                    }
                } else {
                    videoOverlay.classList.remove('hidden');
                    this.destroyPlayer();
                }
            }
        } catch (error) {
            // 静默处理错误，避免在控制台产生过多噪音
            // console.warn('Stream status update failed:', error);
        }
    }

    // 电源控制
    async setPowerState(on) {
        try {
            await this.apiCall('/power/camera', 'POST', { on });
            
            // 如果关闭电源且正在直播，则停止直播
            if (!on && this.isStreaming) {
                await this.stopStream();
                this.showToast('info', '自动停止直播', '摄像头关闭，直播已自动停止');
            }
            
            await this.updatePowerStatus(); // 重新获取状态
            this.showToast('success', '电源控制', `摄像头已${on ? '开启' : '关闭'}`);
        } catch (error) {
            console.error('Power control failed:', error);
            await this.updatePowerStatus(); // 恢复状态
            this.showToast('error', '电源控制失败', error.message);
        }
    }

    async updatePowerStatus() {
        try {
            const response = await this.apiCall('/power/camera');
            const status = document.getElementById('power-status');
            const button = document.getElementById('power-button');
            
            // 更新状态文本
            status.textContent = response.on ? '开启' : '关闭';
            
            // 更新按钮样式
            if (response.on) {
                button.className = 'btn btn-power btn-power-on';
                button.querySelector('i').className = 'fas fa-power-off';
            } else {
                button.className = 'btn btn-power btn-power-off';
                button.querySelector('i').className = 'fas fa-power-off';
            }
            
        } catch (error) {
            console.error('Update power status failed:', error);
        }
    }

    async togglePower() {
        try {
            const status = document.getElementById('power-status');
            const isOn = status.textContent === '开启';
            await this.setPowerState(!isOn);
        } catch (error) {
            this.showToast('error', '电源切换失败', error.message);
        }
    }

    // 舵机控制
    async setServoAngle(axis, angle) {
        try {
            const response = await this.apiCall(`/motion/${axis}`, 'POST', { angle });
            
            // 验证返回的轴信息，防止数据串扰
            if (response.axis && response.axis !== axis) {
                console.error(`Data corruption: requested ${axis} but got response for ${response.axis}`);
                this.showToast('error', '数据异常', `${axis}舵机控制数据异常，请重试`);
                return;
            }
            
            if (response.status === 'error') {
                if (response.error === 'servo_communication_failed') {
                    this.showToast('warning', '舵机通信', `${axis}舵机通信失败，请检查连接`);
                } else {
                    this.showToast('error', '舵机控制失败', response.message || '未知错误');
                }
                return;
            }
            
            if (response.status === 'limited') {
                this.showToast('info', '角度限制', `${axis}舵机角度被限制在安全范围内`);
            }
            
            // 立即刷新实际位置（实际运动有延迟，刷新多次）
            setTimeout(() => this.updateServoPositions(), 200);
            setTimeout(() => this.updateServoPositions(), 600);
            setTimeout(() => this.updateServoPositions(), 1200);
        } catch (error) {
            console.error('Servo control failed:', error);
            // 只在严重错误时显示提示
            if (error.message.includes('HTTP 500')) {
                this.showToast('error', '舵机故障', '舵机通信异常，请检查硬件连接');
            }
            this.updateServoPositions();
        }
    }

    // 带节流的舵机角度调整
    throttledServoAdjust(panDelta, tiltDelta) {
        const now = Date.now();
        if (now - this.lastServoCall < this.servoCallDelay) {
            if (this.servoThrottle) {
                clearTimeout(this.servoThrottle);
            }
            this.servoThrottle = setTimeout(() => {
                this.adjustServoAngles(panDelta, tiltDelta);
            }, this.servoCallDelay);
            return;
        }
        
        this.lastServoCall = now;
        this.adjustServoAngles(panDelta, tiltDelta);
    }

    async adjustServoAngles(panDelta, tiltDelta) {
        const panSlider = document.getElementById('pan-slider');
        const tiltSlider = document.getElementById('tilt-slider');
        
        // 串行处理，避免并发调用导致数据串扰
        if (panDelta !== 0) {
            const newPan = Math.max(-45, Math.min(45, parseInt(panSlider.value) + panDelta));
            if (newPan !== parseInt(panSlider.value)) {
                panSlider.value = newPan;
                this.updateSliderValue('pan', newPan);
                await this.setServoAngle('pan', newPan);
                // 小延迟，避免连续调用串口冲突
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        
        if (tiltDelta !== 0) {
            const newTilt = Math.max(-45, Math.min(45, parseInt(tiltSlider.value) + tiltDelta));
            if (newTilt !== parseInt(tiltSlider.value)) {
                tiltSlider.value = newTilt;
                this.updateSliderValue('tilt', newTilt);
                await this.setServoAngle('tilt', newTilt);
            }
        }
    }

    async centerServos() {
        // 串行调用，避免并发控制导致数据串扰
        await this.setServoAngle('pan', 0);
        await new Promise(resolve => setTimeout(resolve, 100)); // 小延迟
        await this.setServoAngle('tilt', 0);
        
        // 更新UI
        document.getElementById('pan-slider').value = 0;
        document.getElementById('tilt-slider').value = 0;
        this.updateSliderValue('pan', 0);
        this.updateSliderValue('tilt', 0);
    }

    async updateServoPositions() {
        try {
            // 串行获取舵机位置，避免并发访问导致数据串扰
            const panResponse = await this.apiCall('/motion/pan').catch(e => ({ error: 'api_error', axis: 'pan' }));
            await new Promise(resolve => setTimeout(resolve, 50)); // 小延迟避免串口冲突
            const tiltResponse = await this.apiCall('/motion/tilt').catch(e => ({ error: 'api_error', axis: 'tilt' }));
            
            const panSlider = document.getElementById('pan-slider');
            const tiltSlider = document.getElementById('tilt-slider');
            
            // 处理Pan响应 - 验证返回的轴标识
            if (panResponse && panResponse.axis === 'pan' && !panResponse.error && typeof panResponse.angle === 'number') {
                const pan = panResponse.angle;
                if (panSlider) {
                    panSlider.value = pan;
                    this.updateSliderValue('pan', pan);
                }
            } else if (panResponse && panResponse.error === 'communication_error') {
                console.warn('Pan servo communication error, keeping current value');
            } else if (panResponse && panResponse.axis !== 'pan') {
                console.error('Data corruption detected: expected pan axis but got', panResponse.axis);
                this.showToast('warning', '数据异常', 'Pan轴数据可能异常，请刷新页面');
            }
            
            // 处理Tilt响应 - 验证返回的轴标识
            if (tiltResponse && tiltResponse.axis === 'tilt' && !tiltResponse.error && typeof tiltResponse.angle === 'number') {
                const tilt = tiltResponse.angle;
                if (tiltSlider) {
                    tiltSlider.value = tilt;
                    this.updateSliderValue('tilt', tilt);
                }
            } else if (tiltResponse && tiltResponse.error === 'communication_error') {
                console.warn('Tilt servo communication error, keeping current value');
            } else if (tiltResponse && tiltResponse.axis !== 'tilt') {
                console.error('Data corruption detected: expected tilt axis but got', tiltResponse.axis);
                this.showToast('warning', '数据异常', 'Tilt轴数据可能异常，请刷新页面');
            }
        } catch (error) {
            console.error('Update servo positions failed:', error);
            // 不显示错误提示，避免频繁弹窗，也不重置角度值
        }
    }

    updateSliderValue(axis, value) {
        document.getElementById(`${axis}-value`).textContent = parseFloat(value).toFixed(2);
    }

    // 舵机限位
    async setServoLimits(axis) {
        try {
            const minInput = document.getElementById(`${axis}-min`);
            const maxInput = document.getElementById(`${axis}-max`);
            
            const min = parseInt(minInput.value);
            const max = parseInt(maxInput.value);
            
            if (isNaN(min) || isNaN(max)) {
                this.showToast('warning', '输入错误', '请输入有效的角度值');
                return;
            }
            
            await this.apiCall(`/motion/${axis}/limit`, 'POST', { min, max });
            this.showToast('success', '限位设置', `${axis === 'pan' ? '水平' : '垂直'}限位已更新`);
            
        } catch (error) {
            console.error('Set servo limits failed:', error);
        }
    }

    async updateServoLimits() {
        try {
            const panLimits = await this.apiCall('/motion/pan/limit');
            const tiltLimits = await this.apiCall('/motion/tilt/limit');
            panLimits.min +=1; // 减1，避免限位过紧
            panLimits.max -=1; // 加1，避免限位过紧
            tiltLimits.min +=1; // 减1，避免限位过紧
            tiltLimits.max -=1; // 加1，避免限位过紧
            
            document.getElementById('pan-min').value = panLimits.min;
            document.getElementById('pan-max').value = panLimits.max;
            // console.log('Pan limits:', panLimits);
            document.getElementById('tilt-min').value = tiltLimits.min;
            document.getElementById('tilt-max').value = tiltLimits.max;
            // console.log('Tilt limits:', tiltLimits);
            // 新增：同步滑块的min/max
            const panSlider = document.getElementById('pan-slider');
            panSlider.min = panLimits.min;
            panSlider.max = panLimits.max;
            // 若当前值超出新限位，修正
            if (parseInt(panSlider.value) < panLimits.min) panSlider.value = panLimits.min;
            if (parseInt(panSlider.value) > panLimits.max) panSlider.value = panLimits.max;
            this.updateSliderValue('pan', panSlider.value);
            const tiltSlider = document.getElementById('tilt-slider');
            tiltSlider.min = tiltLimits.min;
            tiltSlider.max = tiltLimits.max;
            if (parseInt(tiltSlider.value) < tiltLimits.min) tiltSlider.value = tiltLimits.min;
            if (parseInt(tiltSlider.value) > tiltLimits.max) tiltSlider.value = tiltLimits.max;
            this.updateSliderValue('tilt', tiltSlider.value);
        } catch (error) {
            console.error('Update servo limits failed:', error);
        }
    }

    // 系统信息
    async updateSystemInfo() {
        try {
            const [hostnameResponse, ipResponse] = await Promise.all([
                this.apiCall('/system/hostname'),
                this.apiCall('/system/ip')
            ]);
            
            // 更新头部显示 - hostname (ip)格式
            document.getElementById('hostname-display').textContent = `${hostnameResponse.hostname} (${ipResponse.ip})`;
            
            // 更新系统控制面板中的主机名
            document.getElementById('hostname-input').value = hostnameResponse.hostname;
            
            this.updateConnectionStatus(true);
        } catch (error) {
            console.error('Update system info failed:', error);
            this.updateConnectionStatus(false);
            document.getElementById('hostname-display').textContent = '连接失败';
        }
    }

    async updateTemperature() {
        try {
            const response = await this.apiCall('/system/temperature');
            // 优先显示cpu/gpu温度，否则显示最大值
            let temp = null;
            if ('cpu' in response) temp = response.cpu;
            else if ('gpu' in response) temp = response.gpu;
            else if (Object.values(response).length > 0) temp = Math.max(...Object.values(response));
            
            const tempDisplay = document.getElementById('temperature-display');
            const tempStatus = document.getElementById('temperature-status');
            
            if (temp !== null && !isNaN(temp)) {
                tempDisplay.textContent = `${temp.toFixed(1)}°C`;
                tempStatus.querySelector('span').textContent = `${temp.toFixed(1)}°C`;
                
                // 温度警告
                if (temp >= 80) {
                    tempStatus.classList.add('hot');
                } else {
                    tempStatus.classList.remove('hot');
                }
            } else {
                tempDisplay.textContent = '--°C';
                tempStatus.querySelector('span').textContent = '--°C';
                tempStatus.classList.remove('hot');
            }
        } catch (error) {
            document.getElementById('temperature-display').textContent = '--°C';
        }
    }

    updateConnectionStatus(connected) {
        const status = document.getElementById('connection-status');
        const icon = status.querySelector('i');
        const text = status.querySelector('span');
        
        if (connected) {
            status.classList.remove('disconnected');
            status.classList.add('connected');
            text.textContent = '已连接';
        } else {
            status.classList.remove('connected');
            status.classList.add('disconnected');
            text.textContent = '连接断开';
        }
    }

    // 系统重启
    async rebootSystem() {
        if (!confirm('确定要重启系统吗？此操作将断开所有连接。')) {
            return;
        }
        
        const button = document.getElementById('reboot-button');
        const originalHtml = button.innerHTML;
        
        try {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span class="button-label">重启中</span><span class="button-status">请等待...</span>';
            
            const response = await this.apiCall('/power/system', 'POST');
            
            if (response.status === 'ok') {
                this.showToast('info', '系统重启', '系统即将重启，页面将断开连接');
                // 30秒后恢复按钮（防止误判）
                setTimeout(() => {
                    button.disabled = false;
                    button.innerHTML = originalHtml;
                }, 30000);
            } else {
                throw new Error(response.msg || '重启失败');
            }
        } catch (error) {
            console.error('Reboot failed:', error);
            this.showToast('error', '重启失败', error.message);
            button.disabled = false;
            button.innerHTML = originalHtml;
        }
    }

    // 主机名编辑
    async toggleHostnameEdit() {
        const input = document.getElementById('hostname-input');
        const button = document.getElementById('hostname-edit');
        
        if (input.readOnly) {
            input.readOnly = false;
            input.focus();
            input.select();
            button.innerHTML = '<i class="fas fa-check"></i>';
        } else {
            try {
                const hostname = input.value.trim();
                if (hostname) {
                    await this.apiCall('/system/hostname', 'POST', { hostname });
                    this.showToast('success', '主机名更新', '主机名已更新，设备将重启');
                }
                input.readOnly = true;
                button.innerHTML = '<i class="fas fa-edit"></i>';
            } catch (error) {
                console.error('Hostname update failed:', error);
                this.updateSystemInfo(); // 恢复原值
            }
        }
    }

    // 键盘帮助
    toggleKeyboardHelp() {
        const help = document.getElementById('keyboard-help');
        help.classList.toggle('show');
    }

    // Toast通知
    showToast(type, title, message) {
        // 避免同类toast重复弹出
        const container = document.getElementById('toast-container');
        // 移除同类型toast
        Array.from(container.querySelectorAll('.toast.' + type)).forEach(t => container.removeChild(t));
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const iconMap = {
            success: 'fas fa-check-circle',
            error: 'fas fa-exclamation-circle',
            warning: 'fas fa-exclamation-triangle',
            info: 'fas fa-info-circle'
        };
        toast.innerHTML = `
            <i class="${iconMap[type]}"></i>
            <div class="toast-content">
                <div class="toast-title">${title}</div>
                <div class="toast-message">${message}</div>
            </div>
        `;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideIn 0.3s ease reverse';
            setTimeout(() => {
                if (toast.parentNode) container.removeChild(toast);
            }, 250);
        }, 2500);
    }

    // 清理资源
    destroy() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        
        this.destroyPlayer();
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    window.cameraController = new CameraController();
});

// 页面卸载时清理资源
window.addEventListener('beforeunload', () => {
    if (window.cameraController) {
        window.cameraController.destroy();
    }
});

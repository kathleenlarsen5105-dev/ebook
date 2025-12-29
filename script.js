const PDF_URL = 'my-book.pdf'; 

let pdfDoc = null;
let bookFlip = null;
let fabricPages = [];
let currentMode = 'read';
let currentTool = 'pen';
let isMobile = window.innerWidth < 768;

// --- متغيرات التكبير والتحريك ---
let currentZoom = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let startX = 0;
let startY = 0;

// --- متغيرات الزوم باللمس ---
let initialPinchDistance = 0;
let initialZoom = 1;

// --- متغيرات النظام ---
let isFlipLocked = false;
let isSpeaking = false;
let speechSynth = window.speechSynthesis;
let speechUtterance = null;
let bookmarks = [];

// --- إعدادات الفيديو ---
const TARGET_VIDEO_PAGE = 3; 

// === 1. تهيئة التطبيق (Init) ===
async function initApp() {
    try {
        const container = document.getElementById('book-viewport');
        // هوامش صغيرة لحماية الأطراف
        const maxWidth = container.clientWidth - (isMobile ? 10 : 40); 
        const maxHeight = container.clientHeight - (isMobile ? 10 : 40);

        const loadingTask = pdfjsLib.getDocument(PDF_URL);
        pdfDoc = await loadingTask.promise;

        const page1 = await pdfDoc.getPage(1);
        const viewportRaw = page1.getViewport({ scale: 1 });
        const aspectRatio = viewportRaw.width / viewportRaw.height;

        let pageWidth, pageHeight;

        // حساب الأبعاد بذكاء
        if (isMobile) {
            pageWidth = maxWidth;
            pageHeight = pageWidth / aspectRatio;
            if (pageHeight > maxHeight) {
                pageHeight = maxHeight;
                pageWidth = pageHeight * aspectRatio;
            }
        } else {
            pageWidth = maxWidth / 2;
            pageHeight = pageWidth / aspectRatio;
            if (pageHeight > maxHeight) {
                pageHeight = maxHeight;
                pageWidth = pageHeight * aspectRatio;
            }
        }

        pageWidth = Math.floor(pageWidth);
        pageHeight = Math.floor(pageHeight);

        const bookContainer = document.getElementById('book-container');
        
        // إنشاء الهيكل الفارغ للصفحات (سريع جداً)
        for (let i = 1; i <= pdfDoc.numPages; i++) {
            const div = document.createElement('div');
            div.className = 'page-wrapper';
            div.innerHTML = `<canvas id="canvas-page-${i}"></canvas>`;
            bookContainer.appendChild(div);
        }

        // إعداد مكتبة التقليب
        bookFlip = new St.PageFlip(bookContainer, {
            width: pageWidth,
            height: pageHeight,
            size: 'fixed',
            maxShadowOpacity: 0.3, // تخفيف الظل لتحسين الأداء
            showCover: true,
            usePortrait: isMobile,
            startPage: 0
        });

        bookFlip.loadFromHTML(document.querySelectorAll('.page-wrapper'));

        // === سر السرعة هنا: نحمل أول 3 صفحات فقط ثم نفتح التطبيق ===
        const initialPagesToLoad = Math.min(3, pdfDoc.numPages);
        for (let i = 1; i <= initialPagesToLoad; i++) {
            await renderPageOnFabric(i, pageWidth, pageHeight);
        }

        // إخفاء اللودر فوراً (الطالب كدة شاف الكتاب فتح)
        const loader = document.getElementById('loader');
        loader.style.opacity = '0';
        setTimeout(() => { loader.style.display = 'none'; }, 800);

        // تحميل باقي الصفحات في الخلفية (بدون تجميد الشاشة)
        if (pdfDoc.numPages > initialPagesToLoad) {
            loadRemainingPagesCheck(initialPagesToLoad + 1, pageWidth, pageHeight);
        }

        await buildTableOfContents();
        
        const flipSound = document.getElementById('flip-sound');
        if(flipSound) flipSound.volume = 0.2;

        // أحداث التقليب
        bookFlip.on('flip', (e) => {
            currentZoom = 1; panX = 0; panY = 0; applyZoom();
            if(flipSound) { flipSound.currentTime = 0; flipSound.play().catch(e => {}); }

            const currentPage = e.data + 1;
            updatePageNum(currentPage);
            highlightTocItem(e.data);
            
            // تحديث أيقونة العلامة
            const btnIcon = document.querySelector('#btn-bookmark i');
            if (btnIcon) {
                if (bookmarks.includes(currentPage)) {
                    btnIcon.className = 'fas fa-bookmark'; btnIcon.style.color = '#ff0000'; 
                } else {
                    btnIcon.className = 'far fa-bookmark'; btnIcon.style.color = ''; 
                }
            }
            
            if(isSpeaking) toggleSpeech(); 
            checkVideoTrigger(currentPage);
        });
        
        updatePageNum(1);
        setupZoomPanEvents();
        checkVideoTrigger(1);

    } catch (err) {
        console.error(err);
        document.querySelector('.loader-text').innerText = "خطأ في التحميل";
        alert("تأكد أن ملف my-book.pdf موجود!");
    }
}

// === دالة التحميل في الخلفية (Lazy Loading) ===
function loadRemainingPagesCheck(startPage, w, h) {
    if (startPage > pdfDoc.numPages) return;
    
    // نستخدم setTimeout عشان ندي فرصة للمتصفح يرتاح وميهنجش
    setTimeout(async () => {
        await renderPageOnFabric(startPage, w, h);
        loadRemainingPagesCheck(startPage + 1, w, h); // حمل الصفحة اللي بعدها
    }, 100); // 100 مللي ثانية راحة بين كل صفحة
}

// === 2. الرسم الذكي (Smart Rendering) ===
async function renderPageOnFabric(pageNum, targetWidth, targetHeight) {
    // المعادلة الذكية للدقة:
    // لو موبايل: 1.5 (ممتازة للشاشات الصغيرة وخفيفة جداً)
    // لو كمبيوتر: 2.0 (دقة عالية للشاشات الكبيرة)
    // بلاش 3.0 عشان بتقتل الرامات
    const scaleMult = isMobile ? 1.5 : 2.0; 
    
    const hdWidth = targetWidth * scaleMult;
    const hdHeight = targetHeight * scaleMult;

    const page = await pdfDoc.getPage(pageNum);
    const unscaledViewport = page.getViewport({scale: 1});
    const scaleFactor = hdWidth / unscaledViewport.width;
    const viewport = page.getViewport({ scale: scaleFactor });

    const hiddenCanvas = document.createElement('canvas');
    hiddenCanvas.width = viewport.width;
    hiddenCanvas.height = viewport.height;
    const ctx = hiddenCanvas.getContext('2d');
    
    // تفعيل التنعيم (عشان الـ 1.5 تبان كأنها 3)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;

    const canvasId = `canvas-page-${pageNum}`;
    const fCanvas = new fabric.Canvas(canvasId, {
        width: hdWidth, height: hdHeight, selection: false, renderOnAddRemove: false 
    });

    fCanvas.setZoom(scaleMult);

    const img = new fabric.Image(hiddenCanvas, {
        originX: 'left', originY: 'top', scaleX: 1 / scaleMult, scaleY: 1 / scaleMult, 
        objectCaching: false // هام جداً: يمنع تخزين الصورة في الكاش لتخفيف الرامات
    });

    fCanvas.setBackgroundImage(img, fCanvas.renderAll.bind(fCanvas));
    fCanvas.freeDrawingBrush.width = 3; 
    fCanvas.isDrawingMode = false;
    fabricPages[pageNum - 1] = fCanvas;

    if (bookmarks.includes(pageNum)) {
        addRibbonToCanvas(pageNum);
    }
}

// === 3. التحكم والزوم (Zoom Logic) ===
function setupZoomPanEvents() {
    const viewport = document.getElementById('book-viewport');

    viewport.addEventListener('wheel', (e) => {
        if (currentMode === 'read') {
            e.preventDefault(); 
            const delta = -Math.sign(e.deltaY) * 0.15;
            zoomBook(delta);
        }
    }, { passive: false });

    viewport.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', drag);
    window.addEventListener('mouseup', endDrag);

    viewport.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2 && currentMode === 'read') {
            isDragging = false; 
            initialPinchDistance = getDistance(e.touches);
            initialZoom = currentZoom;
        } else if (e.touches.length === 1) {
            startDrag(e.touches[0]);
        }
    }, { passive: false });

    viewport.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && currentMode === 'read') {
            e.preventDefault();
            const currentDistance = getDistance(e.touches);
            if (initialPinchDistance > 0) {
                const scale = currentDistance / initialPinchDistance;
                let newZoom = initialZoom * scale;
                if(newZoom < 0.6) newZoom = 0.6;
                if(newZoom > 5) newZoom = 5;
                currentZoom = newZoom;
                applyZoom();
            }
        } else if (e.touches.length === 1) {
            drag(e.touches[0]);
        }
    }, { passive: false });

    viewport.addEventListener('touchend', endDrag);
}

function getDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function startDrag(e) {
    if (currentZoom <= 1 || currentMode !== 'read') return;
    isDragging = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
    document.getElementById('book-viewport').classList.add('grabbing');
}

function drag(e) {
    if (!isDragging) return;
    e.preventDefault && e.preventDefault(); 
    panX = e.clientX - startX;
    panY = e.clientY - startY;
    applyZoom();
}

function endDrag() {
    isDragging = false;
    document.getElementById('book-viewport').classList.remove('grabbing');
    applyZoom(); 
}

function zoomBook(amount) {
    let newZoom = currentZoom + amount;
    if(newZoom < 0.6) newZoom = 0.6;
    if(newZoom > 5) newZoom = 5;
    currentZoom = newZoom;
    if (currentZoom <= 1) { currentZoom = 1; panX = 0; panY = 0; }
    applyZoom();
}

function applyZoom() {
    const container = document.getElementById('book-container');
    const viewport = document.getElementById('book-viewport');
    container.style.transform = `translate(${panX}px, ${panY}px) scale(${currentZoom})`;
    if(isDragging) { container.style.transition = "none"; } 
    else { container.style.transition = "transform 0.15s ease-out"; }
    
    if(currentZoom > 1) { viewport.style.cursor = isDragging ? 'grabbing' : 'grab'; } 
    else { viewport.style.cursor = 'default'; }
}

// === 4. الميزات الإضافية (قفل، فيديو، صوت) ===
window.toggleFlipLock = function() {
    isFlipLocked = !isFlipLocked;
    const btn = document.getElementById('btn-lock');
    const icon = btn.querySelector('i');
    const overlay = document.getElementById('flip-lock-overlay');
    if(isFlipLocked) {
        btn.classList.add('locked'); icon.classList.remove('fa-unlock'); icon.classList.add('fa-lock'); overlay.style.display = 'block';
    } else {
        btn.classList.remove('locked'); icon.classList.remove('fa-lock'); icon.classList.add('fa-unlock'); overlay.style.display = 'none';
    }
};

function checkVideoTrigger(pageNum) {
    const btn = document.getElementById('magic-video-btn');
    const oldPopup = document.getElementById('video-popup');
    if(oldPopup) oldPopup.style.display = 'none';

    let shouldShow = false;
    if (pageNum === TARGET_VIDEO_PAGE) { shouldShow = true; } 
    else if (!isMobile && pageNum === (TARGET_VIDEO_PAGE - 1)) { shouldShow = true; }

    if (shouldShow) {
        if(btn) { btn.style.display = 'flex'; setTimeout(() => { btn.classList.add('visible'); }, 100); }
    } else {
        if(btn) { btn.classList.remove('visible'); setTimeout(() => { btn.style.display = 'none'; }, 300); }
        const video = document.getElementById('promo-video'); if(video) video.pause();
        const modal = document.getElementById('cinema-modal'); if(modal) modal.style.display = 'none';
    }
}

window.openVideoModal = function() {
    const modal = document.getElementById('cinema-modal');
    const video = document.getElementById('promo-video');
    if(modal && video) { modal.style.display = 'flex'; video.currentTime = 0; video.play().catch(e => {}); }
}

window.closeCinemaModal = function(e) {
    if (e.target.id === 'cinema-modal' || e.target.closest('.close-cinema')) {
        const modal = document.getElementById('cinema-modal');
        const video = document.getElementById('promo-video');
        if(video) video.pause();
        if(modal) modal.style.display = 'none';
    }
}

window.closeVideo = function() {
    const popup = document.getElementById('video-popup');
    const video = document.getElementById('page-video');
    if(video) video.pause();
    if(popup) popup.style.display = 'none';
}

async function toggleSpeech() {
    if (isSpeaking) {
        speechSynth.cancel(); isSpeaking = false;
        document.getElementById('btn-speak').classList.remove('speaking-anim');
        document.getElementById('btn-speak').classList.remove('active');
    } else {
        document.getElementById('btn-speak').classList.add('speaking-anim');
        document.getElementById('btn-speak').classList.add('active');
        isSpeaking = true;
        let currentPageIndex = bookFlip.getCurrentPageIndex();
        let textToRead = await extractTextFromPage(currentPageIndex + 1);
        if(!isMobile && (currentPageIndex + 1) < pdfDoc.numPages) {
                let text2 = await extractTextFromPage(currentPageIndex + 2);
                textToRead += " ... " + text2;
        }
        if (!textToRead || textToRead.trim().length === 0) { textToRead = "لا يوجد نص"; }
        speechUtterance = new SpeechSynthesisUtterance(textToRead);
        speechUtterance.lang = 'ar-SA';
        if(textToRead.match(/[a-zA-Z]/g) && textToRead.match(/[a-zA-Z]/g).length > textToRead.length / 2) {
            speechUtterance.lang = 'en-US';
        }
        speechUtterance.onend = () => {
            isSpeaking = false;
            document.getElementById('btn-speak').classList.remove('speaking-anim');
            document.getElementById('btn-speak').classList.remove('active');
        };
        speechSynth.speak(speechUtterance);
    }
}

async function extractTextFromPage(pageNum) {
    try {
        if(pageNum > pdfDoc.numPages) return "";
        const page = await pdfDoc.getPage(pageNum);
        const t = await page.getTextContent();
        return t.items.map(s => s.str).join(' ');
    } catch(e) { return ""; }
}

// === 5. الأدوات والعلامات ===
function toggleBookmark() {
    const pageNum = bookFlip.getCurrentPageIndex() + 1;
    const btnIcon = document.querySelector('#btn-bookmark i');
    if (bookmarks.includes(pageNum)) {
        bookmarks = bookmarks.filter(p => p !== pageNum);
        if(btnIcon) { btnIcon.className = 'far fa-bookmark'; btnIcon.style.color = ''; }
        removeRibbonFromCanvas(pageNum);
    } else {
        bookmarks.push(pageNum); bookmarks.sort((a, b) => a - b);
        if(btnIcon) { btnIcon.className = 'fas fa-bookmark'; btnIcon.style.color = '#ff0000'; }
        addRibbonToCanvas(pageNum);
    }
    updateBookmarksList();
}
function addRibbonToCanvas(pageNum) {
    const canvas = fabricPages[pageNum - 1]; if (!canvas) return;
    const r = new fabric.Polygon([{x:0,y:0},{x:60,y:0},{x:0,y:60}], {fill:'#ff0000', selectable:false, evented:false});
    r.id = 'bookmark-ribbon'; canvas.add(r); canvas.bringToFront(r);
}
function removeRibbonFromCanvas(pageNum) {
    const canvas = fabricPages[pageNum - 1]; if (!canvas) return;
    canvas.getObjects().forEach(o => { if (o.id === 'bookmark-ribbon') canvas.remove(o); });
}
function updateBookmarksList() {
    const list = document.getElementById('bookmarks-list'); list.innerHTML = '';
    const cont = document.getElementById('bookmarks-container');
    if (bookmarks.length === 0) { cont.style.display = 'none'; return; }
    cont.style.display = 'block';
    bookmarks.forEach(p => {
        const d = document.createElement('div'); d.className = 'toc-item';
        d.innerHTML = `<span><i class="fas fa-bookmark" style="color:#f00;margin-left:5px"></i> ص ${p}</span>`;
        d.onclick = () => { if (bookFlip) { bookFlip.flip(p - 1); if(isMobile) toggleSidebar(); } };
        list.appendChild(d);
    });
}

function stopEventPropagation(e) { if(currentMode !== 'read') e.stopPropagation(); }

window.setMode = function(mode, toolType) {
    currentMode = mode;
    document.querySelectorAll('.btn-tool').forEach(b => {
        if(!['btn-speak', 'btn-bookmark', 'btn-lock'].includes(b.id)) b.classList.remove('active');
    });
    
    const prevBtn = document.getElementById('btn-prev');
    const nextBtn = document.getElementById('btn-next');

    if(mode === 'read') {
        document.getElementById('btn-hand').classList.add('active');
        document.getElementById('drawing-options').style.display = 'none';
        prevBtn.disabled = false; nextBtn.disabled = false;
        applyZoom(); 
    }
    else if(mode === 'draw' || mode === 'erase') {
        if(currentZoom > 1) zoomBook(-(currentZoom - 1));
        if (mode === 'draw') {
            document.getElementById(toolType === 'pen' ? 'btn-pen' : 'btn-highlight').classList.add('active');
            document.getElementById('drawing-options').style.display = 'flex';
        } else {
            document.getElementById('btn-eraser').classList.add('active');
            document.getElementById('drawing-options').style.display = 'none';
        }
        prevBtn.disabled = true; nextBtn.disabled = true;
        document.getElementById('book-viewport').style.cursor = 'default';
    }

    fabricPages.forEach(canvas => {
        if (!canvas) return;
        const upperCanvasEl = canvas.upperCanvasEl;
        upperCanvasEl.removeEventListener('mousedown', stopEventPropagation);
        upperCanvasEl.removeEventListener('touchstart', stopEventPropagation);
        if (mode === 'read') {
            canvas.isDrawingMode = false; canvas.defaultCursor = 'default'; canvas.off('mouse:down');
        } else {
            upperCanvasEl.addEventListener('mousedown', stopEventPropagation);
            upperCanvasEl.addEventListener('touchstart', stopEventPropagation);
            if (mode === 'draw') {
                canvas.isDrawingMode = true; canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
                currentTool = toolType; updateBrush(canvas); 
            } else if (mode === 'erase') {
                canvas.isDrawingMode = false; canvas.defaultCursor = 'crosshair'; canvas.off('mouse:down'); 
                canvas.on('mouse:down', o => { if (currentMode === 'erase' && o.target) canvas.remove(o.target); });
            }
        }
    });
};

window.updateBrush = function(c) {
    const clr = document.getElementById('pen-color').value;
    const w = parseInt(document.getElementById('pen-width').value, 10);
    const apply = (cv) => {
        if (!cv || !cv.freeDrawingBrush) return;
        cv.freeDrawingBrush.color = (currentTool === 'highlight') ? convertHexToRGBA(clr, 0.4) : clr;
        cv.freeDrawingBrush.width = (currentTool === 'highlight') ? 20 : w;
    };
    if (c) apply(c); else fabricPages.forEach(apply);
};

function convertHexToRGBA(h, a) {
    let r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

window.clearCurrentPage = function() {
    if(confirm("مسح الصفحة؟")) {
        const i = bookFlip.getCurrentPageIndex();
        if(fabricPages[i]) fabricPages[i].getObjects().forEach(o => fabricPages[i].remove(o));
    }
};

async function buildTableOfContents() {
    const toc = document.getElementById('toc-container');
    const outline = await pdfDoc.getOutline();
    toc.innerHTML = '';
    if (outline && outline.length > 0) {
        outline.forEach(item => {
            const d = document.createElement('div'); d.className = 'toc-item';
            d.innerHTML = `<span>${item.title}</span>`;
            d.onclick = async () => {
                if(currentMode !== 'read') return;
                if (item.dest) {
                    const dst = await pdfDoc.getDestination(item.dest);
                    const idx = await pdfDoc.getPageIndex(dst[0]);
                    bookFlip.flip(idx); if(isMobile) toggleSidebar();
                }
            };
            toc.appendChild(d);
        });
    } else {
        for(let i=0; i < pdfDoc.numPages; i++) {
            const d = document.createElement('div'); d.className = 'toc-item';
            d.innerHTML = `<span>P${i+1}</span>`;
            d.onclick = () => { if(currentMode === 'read') { bookFlip.flip(i); if(isMobile) toggleSidebar(); } };
            toc.appendChild(d);
        }
    }
}

window.toggleSidebar = function() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar').classList.toggle('collapsed');
};

function updatePageNum(i) { document.getElementById('page-num').innerText = `${i} / ${pdfDoc.numPages}`; }
function highlightTocItem(i) {
    const items = document.querySelectorAll('.toc-item');
    items.forEach(x => x.classList.remove('active'));
    if(items[i]) items[i].classList.add('active');
}

window.hideUI = function(e) {
    if (e.target.closest('button') || e.target.closest('input') || 
        e.target.closest('.tool-group') || e.target.closest('#bottom-toolbar') || 
        e.target.closest('#top-header') || e.target.closest('#magic-video-btn')) return;
    document.body.classList.add('fullscreen-mode');
    setTimeout(() => applyZoom(), 450);
}

window.showUI = function() {
    document.body.classList.remove('fullscreen-mode');
    setTimeout(() => applyZoom(), 450);
}

window.addEventListener('load', initApp);
let rT; window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => { if((window.innerWidth<768)!==isMobile) location.reload(); }, 500); });
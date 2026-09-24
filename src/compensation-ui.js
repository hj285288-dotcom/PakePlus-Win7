// ========== 补偿视图：打开 .rtl 补偿文件 → 解析 → 表格展示 ==========
// 文件格式（Renishaw 光栅尺补偿文件，纯文本 CRLF）：
//   HEADER::          File type / Owner / Version no
//   TARGET DATA::     Filetype / Target-count / Targets :（一串目标位置，可能折成多行）
//   USER-TEXT::       Machine / Serial No / Date / Axis 等元信息
//   RUNS::            Run-count
//   DEVIATIONS::      Run Target Data:  后跟「运行号 目标号 偏差」三列
// 表格口径：位置 = 原始目标值 × 1000（文件里是 mm，表头按微米显示）；校正 = 第 1 次测量的偏差。
(function(){
  var page=document.getElementById("compensation-page");
  var openBtn=document.getElementById("comp-open");
  var input=document.getElementById("comp-input");
  var viewport=document.getElementById("comp-viewport");
  var scroll=document.getElementById("comp-scroll");
  var tbody=document.getElementById("comp-body");
  var empty=document.getElementById("comp-empty");
  var infoBox=document.getElementById("comp-info");
  var invertBtn=document.getElementById("comp-invert");
  var exportBtn=document.getElementById("comp-export");
  var invHead=document.getElementById("comp-inv-head");
  var statusEl=document.getElementById("comp-status");
  var mainLabel=document.getElementById("comp-main-label");
  var legendBox=document.getElementById("comp-chart-legend");
  if(!page||!openBtn||!input||!tbody||!scroll||!viewport)return;
  function setStatus(text){if(statusEl)statusEl.textContent=text;}

  var VISIBLE_ROWS=20;    // 视口内同时可见的值个数（其余靠滚动）
  // 行高不再写死：滚动区铺满卡片，行高 = (可用高度 − 表头) ÷ VISIBLE_ROWS；
  // 字号按行高等比放大（基准：18px 行高 ↔ 11px 字号）。
  var BASE_ROW_HEIGHT=18;
  var BASE_FONT=11;
  // 位置直接用文件里的原始单位 mm（不再 ×1000 换成微米——数值少一位数，表格更省空间）

  function escapeHtml(value){
    return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }
  // 位置：文件原始值就是 mm，直接显示（去掉无意义的尾随零：0.000000 → 0、550.000000 → 550）
  function formatPosition(value){
    if(value==null||value===""||isNaN(parseFloat(value)))return "—";
    var n=roundTo(value,state.decimals||3);
    return n==null?"—":String(n);
  }
  // 取反（补偿值为字符串型的原始值）
  function invertValueOf(value){
    if(value==null||value==="")return null;
    if(typeof value==="number")return roundTo(-value,state.decimals||3);
    return invertValue(value);
  }
  // 取反：按字符串换符号，保留原小数位（1.270 → -1.270），避开浮点误差；0.000 不写成 -0.000
  function invertValue(value){
    if(value==null||value==="")return null;
    var m=/^(-?)(\d*\.?\d+)$/.exec(String(value));
    if(!m)return null;
    if(/^0*\.?0*$/.test(m[2]))return m[2];
    return m[1]==="-"?m[2]:"-"+m[2];
  }
  // 平均值要用文件本身的精度收敛一下：浮点相加会出现 0.065000000000000 这类尾巴
  function roundTo(value,dec){
    var n=Number(value);
    if(isNaN(n))return null;
    return Number(n.toFixed(dec));
  }
  // 标准校正列的显示格式化：去掉无意义的尾随零（平均补偿数值已禁用，此函数只服务于标准校正列）
  function formatCell(value){
    if(value==null||value==="")return "—";
    var n=roundTo(value,state.decimals||3);
    return n==null?"—":String(n);
  }
  // 校正：去掉无意义的尾随零（-0.060 → -0.06、3.300 → 3.3）
  function formatCorrection(value){
    if(value==null||value==="")return "—";
    var n=parseFloat(value);
    return isNaN(n)?"—":String(n);
  }

  // ---- 解析 .rtl ----
  function parseRtl(text){
    var lines=String(text).replace(/^\uFEFF/,"").split(/\r?\n/);
    var result={targets:[],deviations:[],meta:{},runCount:0,targetCount:0,filetype:"",source:text};
    var section="",sub="";
    for(var i=0;i<lines.length;i++){
      var trimmed=lines[i].trim();
      if(!trimmed)continue;
      var sec=/^([A-Z][A-Z0-9\- ]*?)::$/.exec(trimmed);
      if(sec){section=sec[1].trim().toUpperCase();sub="";continue;}
      var kv=/^([\w \-]+?)\s*:\s*(.*)$/.exec(trimmed);
      if(section==="TARGET DATA"){
        if(kv){
          var key=kv[1].trim().toLowerCase();
          if(key==="filetype")result.filetype=kv[2].trim();
          if(key==="target-count")result.targetCount=parseInt(kv[2],10)||0;
          sub=(key==="targets")?"targets":"";   // 「Flags:」等其它行会关掉收集
          continue;
        }
        if(sub==="targets"){
          trimmed.split(/\s+/).forEach(function(part){
            var n=parseFloat(part);
            if(!isNaN(n))result.targets.push(n);
          });
        }
        continue;
      }
      if(section==="RUNS"){
        if(kv&&kv[1].trim().toLowerCase()==="run-count")result.runCount=parseInt(kv[2],10)||0;
        continue;
      }
      if(section==="DEVIATIONS"){
        if(kv){sub=/^run target data/i.test(trimmed)?"dev":"";continue;}
        if(sub==="dev"){
          var m=/^(\d+)\s+(\d+)\s+(-?[\d.]+)\s*$/.exec(trimmed);
          if(m)result.deviations.push({run:parseInt(m[1],10),target:parseInt(m[2],10),value:m[3],line:i});
        }
        continue;
      }
      if(kv)result.meta[kv[1].trim()]=kv[2].trim();   // HEADER / USER-TEXT / ENVIRONMENT
    }
    return result;
  }

  // ---- 组装行数据 ----
  function buildRows(parsed){
    var runs={};
    parsed.deviations.forEach(function(d){runs[d.run]=true;});
    var runList=Object.keys(runs).map(Number).sort(function(a,b){return a-b;});
    var run=runList.indexOf(1)>-1?1:(runList[0]||1);   // 默认取第 1 次测量，没有就取最早的一次
    var byTarget={};
    parsed.deviations.forEach(function(d){
      if(d.run!==run)return;
      if(!Object.prototype.hasOwnProperty.call(byTarget,d.target))byTarget[d.target]=d.value;
    });
    // 平均补偿数值已禁用：只保留标准补偿数值（第 1 次测量）。
    var count=parsed.targetCount||parsed.targets.length;
    var rows=[];
    for(var i=0;i<count;i++){
      rows.push({
        index:i+1,
        position:parsed.targets[i],
        correction:Object.prototype.hasOwnProperty.call(byTarget,i+1)?byTarget[i+1]:null
      });
    }
    return {rows:rows,run:run,runCount:runList.length||parsed.runCount};
  }

  // 单击整行 → 黑底白字 + 曲线指示线。选中按「索引」记住，切换来源/置反导致重绘后仍然保持。
  tbody.addEventListener("click",function(event){
    var tr=event.target&&event.target.closest?event.target.closest("tr"):null;
    if(!tr||tr.parentElement!==tbody)return;
    var row=state.rows[Array.prototype.indexOf.call(tbody.children,tr)];
    if(!row)return;
    var already=state.selectedIndex===row.index;
    Array.prototype.forEach.call(tbody.children,function(item){item.classList.remove("is-selected");});
    if(already){state.selectedIndex=null;}                        // 再点一次 = 取消选中
    else{state.selectedIndex=row.index;tr.classList.add("is-selected");}
    renderChart();                                               // 曲线上的指示线跟着走
  });

  // ---- 渲染 ----
  // selectedIndex：表格里被单击选中的「索引」（1..N），null = 未选中。用于行高亮 + 曲线指示线。
  var state={rows:[],parsed:null,name:"",run:1,inverted:false,raw:"",decimals:3,selectedIndex:null};
  // 当前这一行要显示的值：标准补偿数值（第 1 次测量）。平均补偿数值已禁用。
  function valueOf(row){
    if(!row)return null;
    return row.correction;
  }

  function renderTable(){
    tbody.innerHTML=state.rows.map(function(row){
      return '<tr class="border-b border-slate-100'+(row.index===state.selectedIndex?' is-selected':'')+'">'
        +'<td class="px-2 py-[1.5px] text-[11px] leading-[14px] text-slate-400 whitespace-nowrap">'+row.index+'</td>'
        +'<td class="px-2 py-[1.5px] text-[11px] leading-[14px] text-slate-700 text-center whitespace-nowrap">'+escapeHtml(formatPosition(row.position))+'</td>'
        +'<td class="px-2 py-[1.5px] text-[11px] leading-[14px] text-slate-800 text-right whitespace-nowrap">'+escapeHtml(formatCell(valueOf(row)))+'</td>'
        +(state.inverted?'<td class="px-2 py-[1.5px] text-[11px] leading-[14px] text-orange-600 text-right whitespace-nowrap">'+escapeHtml(formatCell(invertValueOf(valueOf(row))))+'</td>':'')
        +'</tr>';
    }).join("");
  }

  // 「正好 20 个」+ 铺满卡片：
  //   ① 滚动区高度 = 卡片可用高度（不再写死）→ 表格下方不留白，能用的高度全给表格；
  //   ② 行高 = (可用高度 − 表头) ÷ 20 → 每行尽量高；
  //   ③ 字号按行高等比放大（基准 18px 行高 ↔ 11px 字号），行高变大字也跟着变大。
  //   表头高度会随字号变化、反过来影响行高，所以迭代 3 轮让它收敛。
  function sizeViewport(){
    var table=document.getElementById("comp-table");
    var avail=viewport.clientHeight;
    if(avail<40)return;                        // 视图被隐藏时容器尺寸为 0，等 viewchange 再算
    // 滚动区含 1px 上下边框：clientHeight 比 offsetHeight 少 2px，由 clientHeight 参与计算即可
    scroll.style.height=avail+"px";
    for(var pass=0;pass<3;pass++){
      var headH=table&&table.tHead?table.tHead.getBoundingClientRect().height:0;
      var rowH=(scroll.clientHeight-headH)/VISIBLE_ROWS;
      // 取 1/4 像素步进：避免小数累积把第 20 行挤出可视区（宁可少算不足 1px，也不能多算）
      rowH=Math.max(BASE_ROW_HEIGHT,Math.floor(rowH*4)/4);
      var font=Math.round(BASE_FONT*rowH/BASE_ROW_HEIGHT*2)/2;             // 等比放大，取 0.5px
      var line=Math.min(Math.round(font*1.27*2)/2,Math.max(10,rowH-4));    // 文字行高不能顶满行高
      // 表头字号比正文小一号：-2px、下限 10px（用户要求"缩小一号"），行高按同比例
      var headFont=Math.max(10,Math.round((font-2)*2)/2);
      var headLine=Math.round(headFont*1.27*2)/2;
      scroll.style.setProperty("--comp-row-h",rowH+"px");
      scroll.style.setProperty("--comp-font",font+"px");
      scroll.style.setProperty("--comp-line",line+"px");
      scroll.style.setProperty("--comp-head-font",headFont+"px");
      scroll.style.setProperty("--comp-head-line",headLine+"px");
    }
    fitWidth();
  }

  // 列内边距自适应：3 列时表格本来就是 w-full（撑满，不溢出）；开「置反」变 4 列后
  // 单元格里的数字更长，内容可能超过可用宽度 → 从 8px 起逐 px 收紧，收到刚好不横向溢出为止。
  // 全部单元格都是 whitespace-nowrap，所以只改左右内边距不会引起换行、也不影响行高。
  function fitWidth(){
    var table=document.getElementById("comp-table");
    if(!table)return;
    var available=scroll.clientWidth;
    var pad=8;
    scroll.style.setProperty("--comp-pad",pad+"px");
    while(pad>2&&table.getBoundingClientRect().width>available+0.5){
      pad-=1;
      scroll.style.setProperty("--comp-pad",pad+"px");
    }
  }

  function renderInfo(){
    var p=state.parsed;
    if(!p){infoBox.innerHTML="";return;}   // 默认态留空，不写占位文字
    var meta=p.meta||{};
    var pairs=[
      ["文件名",state.name],
      ["文件类型",(p.filetype||"rtl")],
      ["版本",meta["Version no"]||"—"],
      ["所有者",meta["Owner"]||"—"],
      ["机床",meta["Machine"]||"—"],
      ["序列号",meta["Serial No"]||"—"],
      ["测量日期",meta["Date"]||"—"],
      ["轴",meta["Axis"]||"—"],
      ["目标点数",p.targetCount||state.rows.length],
      ["运行次数",state.runCount||1],
      ["当前取值","标准补偿数值（第 "+state.run+" 次测量）"],
      ["取反","是"+(state.inverted?"（表格与生成的文件都已置反）":"（否）")],
      ["位置单位","毫米 (mm)，即文件里的原始目标值"]
    ];
    infoBox.innerHTML=pairs.map(function(kv){
      return '<div class="flex items-baseline gap-2"><span class="w-16 flex-shrink-0 text-[10px] text-slate-500">'+escapeHtml(kv[0])+'</span>'
        +'<span class="text-xs text-slate-800 break-all">'+escapeHtml(kv[1])+'</span></div>';
    }).join("");
  }

  function load(text,name){
    var parsed=parseRtl(text);
    if(!parsed.targets.length&&!parsed.deviations.length){
      setStatus(name+"（解析不到数据，请确认是 .rtl 补偿文件）");
      return false;
    }
    var built=buildRows(parsed);
    state={rows:built.rows,parsed:parsed,name:name,run:built.run,runCount:built.runCount,inverted:state.inverted,raw:text,
           decimals:state.decimals,selectedIndex:null};
    var dec=3;
    parsed.deviations.forEach(function(x){var m=/\.(\d+)$/.exec(String(x.value));if(m)dec=Math.max(dec,m[1].length);});
    state.decimals=dec;
    if(invertBtn)invertBtn.disabled=false;
    if(exportBtn){
      exportBtn.classList.remove("hidden");                 // 打开 .rtl 后才显示「生成文件」
      exportBtn.disabled=!(parsed.deviations.length);
    }
    updateState();
    renderTable();
    renderInfo();
    empty.classList.add("hidden");
    scroll.classList.remove("hidden");
    sizeViewport();
    scroll.scrollTop=0;
    setStatus("");   // 成功载入时清掉上一次残留的提示（错误信息 / 「已生成…」）
    return true;
  }

  // ---- 交互 ----
  openBtn.addEventListener("click",function(){input.click();});

  input.addEventListener("change",function(){
    var file=input.files&&input.files[0];
    if(!file)return;
    var reader=new FileReader();
    reader.onload=function(){
      // 先按 UTF-8 严格解码，失败再退回 GBK（机床名等字段可能是中文）
      var buffer=reader.result;
      var text="";
      try{text=new TextDecoder("utf-8",{fatal:true}).decode(buffer);}
      catch(error){try{text=new TextDecoder("gbk").decode(buffer);}catch(error2){text=new TextDecoder("latin1").decode(buffer);}}
      load(text,file.name);
    };
    reader.onerror=function(){setStatus("文件读取失败，请重试");};
    reader.readAsArrayBuffer(file);
    input.value="";   // 清空以便再次选择同一个文件
  });

  window.addEventListener("resize",function(){if(state.rows.length){sizeViewport();renderChart();}});
  // 切到本视图时容器才有尺寸，此时补画（尺寸依赖容器，隐藏时画不了）
  document.addEventListener("viewchange",function(event){
    if(!event.detail||event.detail.view!=="compensation")return;
    if(state.rows.length)sizeViewport();
    renderChart();
  });

  // ---- 补偿曲线：手写 SVG（无背景网格，只留刻度数字与外框；曲线配色见 renderChart：标准=绿。平均补偿数值已禁用，不再绘制粉色对比线）----
  // 不引 Chart.js：本项目是离线双击打开，加 CDN 会破坏离线可用。
  function chartSvg(w,h,series,tag,marker){
    var padL=66,padR=16,padT=12,padB=46;
    var pw=w-padL-padR,ph=h-padT-padB;
    if(pw<60||ph<50)return "";
    var all=[];
    series.forEach(function(s){all=all.concat(s.points);});
    if(!all.length)return "";
    // 值域要覆盖所有曲线（对比时两条都要装得下）
    var iMin=Infinity,iMax=-Infinity,mn=Infinity,mx=-Infinity;
    all.forEach(function(p){if(p.i<iMin)iMin=p.i;if(p.i>iMax)iMax=p.i;if(p.v<mn)mn=p.v;if(p.v>mx)mx=p.v;});
    var span0=(mx-mn)||1;
    var lo=Math.min(0,mn),hi=Math.max(0,mx);
    // 极小的负值（如点1 = -0.06）要当作 0，否则 floor(-0.06/10)*10 会把刻度拉到 -10，白占一整格
    if(lo<0&&-lo<span0*0.02)lo=0;
    if(hi>0&&hi<span0*0.02)hi=0;
    if(hi===lo)hi=lo+span0;
    var span=hi-lo,cand=[0.1,0.2,0.5,1,2,5,10,20,25,50,100,200,500,1000],step=cand[cand.length-1];
    for(var k=0;k<cand.length;k++){if(span/cand[k]<=6){step=cand[k];break;}}
    // 上下各留 2% 余量，曲线不贴框；刻度只画落在区间内的整步长值（不再向外取整）
    var pad=(hi-lo)*0.02;
    lo-=pad;hi+=pad;
    // ⚠️ 刻度线只画在 y0 起的整步长位置上；而坐标映射必须用「取值范围」lo/hi，两者不能混用。
    // 混用会导致数据超出最低刻度时被画到框外（置反时数据到 -44、最低刻度 -40，就会溢出 4 个单位 ≈ 28px）。
    var y0=Math.ceil(lo/step)*step;
    var sx=function(i){return padL+(iMax>iMin?(i-iMin)/(iMax-iMin):0)*pw;};
    var sy=function(v){return padT+ph-((v-lo)/(hi-lo))*ph;};
    var dec=step>=1?0:(step>=0.1?1:2),fx=function(v){return v.toFixed(dec);};
    var T='#404040';               // 刻度文字颜色（背景网格与外框都已按用户要求去掉）
    var out=['<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'" xmlns="http://www.w3.org/2000/svg">'];
    for(var v=y0;v<=hi+1e-9;v+=step){
      var y=sy(v);
      out.push('<text x="'+(padL-8)+'" y="'+y+'" text-anchor="end" dominant-baseline="central" font-size="10" fill="'+T+'">'+fx(v)+'</text>');
    }
    var xstep=1,xs=[1,2,5,10,20,25,50,100,200,500,1000];
    for(var si=0;si<xs.length;si++){if((iMax-iMin)/xs[si]<=8){xstep=xs[si];break;}}
    if(xstep>1){
      for(var t=Math.ceil(iMin/xstep)*xstep;t<=iMax;t+=xstep){
        var x=sx(t);
        out.push('<text x="'+x+'" y="'+(padT+ph+16)+'" text-anchor="middle" font-size="10" fill="'+T+'">'+t+'</text>');
      }
    }
    // 指示线：竖线标位置、横线标数值（虚线，压在曲线下层）
    if(marker){
      out.push('<line x1="'+sx(marker.i).toFixed(2)+'" y1="'+padT+'" x2="'+sx(marker.i).toFixed(2)+'" y2="'+(padT+ph)+'" stroke="#94A3B8" stroke-width="1" stroke-dasharray="3 3"/>');
      out.push('<line x1="'+padL+'" y1="'+sy(marker.v).toFixed(2)+'" x2="'+(padL+pw)+'" y2="'+sy(marker.v).toFixed(2)+'" stroke="#94A3B8" stroke-width="1" stroke-dasharray="3 3"/>');
    }
    series.forEach(function(se){
      if(!se.points.length)return;
      out.push('<path d="'+se.points.map(function(p,idx){return (idx?"L":"M")+sx(p.i).toFixed(2)+" "+sy(p.v).toFixed(2);}).join(" ")+'" fill="none" stroke="'+se.color+'" stroke-width="'+se.width+'" stroke-linejoin="round" stroke-linecap="round"/>');
    });
    // 指示点（画在曲线之上）
    if(marker){
      out.push('<circle cx="'+sx(marker.i).toFixed(2)+'" cy="'+sy(marker.v).toFixed(2)+'" r="3.5" fill="'+marker.color+'" stroke="#fff" stroke-width="1.5"/>');
    }
    out.push('<text x="18" y="'+(padT+ph/2)+'" text-anchor="middle" dominant-baseline="central" font-size="11" fill="#262626" transform="rotate(-90 18 '+(padT+ph/2)+')">'+tag+' (微米)</text>');
    out.push('<text x="'+(padL+pw/2)+'" y="'+(h-8)+'" text-anchor="middle" font-size="11" fill="#262626">索引</text>');
    out.push('</svg>');
    return out.join("");
  }
  function renderChart(){
    var host=document.getElementById("comp-chart");
    if(!host)return;
    if(!state.rows.length){
      host.innerHTML="";   // 默认态留空，不写占位文字
      return;
    }
    var w=host.clientWidth,h=host.clientHeight;
    if(w<80||h<80)return;              // 视图被隐藏时容器没有尺寸，等 viewchange 再画
    // 标准补偿数值 = 第 1 次测量（平均补偿数值已禁用，不再绘制粉色对比线）。
    var std=[];
    function num(v){
      if(v==null||v==="")return null;
      var n=typeof v==="number"?v:parseFloat(v);
      if(isNaN(n))return null;
      return state.inverted?-n:n;
    }
    state.rows.forEach(function(row){
      var a=num(row.correction);
      if(a!=null)std.push({i:row.index,v:a});
    });
    // 曲线配色：标准补偿数值 = 绿
    var COLOR_STD="#22C55E";
    var series=[{points:std,color:COLOR_STD,width:1.6}];
    // 表格里被单击的那一行 → 曲线上用「竖线 + 横线 + 圆点」指向它的值（标准补偿数值，绿线）。
    var marker=null;
    if(state.selectedIndex!=null){
      var picked=state.rows.filter(function(r){return r.index===state.selectedIndex;})[0];
      var mv=picked?num(valueOf(picked)):null;
      if(mv!=null)marker={i:picked.index,v:mv,color:COLOR_STD};
    }
    if(!std.length){host.innerHTML="";return;}
    host.innerHTML=chartSvg(w,h,series,"校正",marker);
    if(legendBox){legendBox.classList.add("hidden");legendBox.classList.remove("flex");legendBox.innerHTML="";}
  }

  // ---- 统一的界面状态刷新：来源 / 置反 会同时影响 表头文字、置反列、生成按钮文案、文件信息 ----
  function variantTag(){
    return state.inverted?"标准·置反":"标准";
  }
  function updateState(){
    if(mainLabel)mainLabel.textContent="校正";
    if(invertBtn)invertBtn.classList.toggle("on",state.inverted);
    if(invHead)invHead.classList.toggle("hidden",!state.inverted);
    if(exportBtn)exportBtn.textContent="生成文件（"+variantTag()+"）";
    renderTable();
    renderInfo();
    sizeViewport();
    renderChart();
  }
  if(invertBtn)invertBtn.addEventListener("click",function(){
    if(!state.rows.length)return;
    state.inverted=!state.inverted;
    updateState();
  });

  // ---- 生成置反文件：结构、排版原样保留，只把 DEVIATIONS 里的补偿值换号 ----
  function exportName(){
    var base=String(state.name||"补偿文件").replace(/\.rtl$/i,"");
    var suffix=state.inverted?"置反":"";
    return base+(suffix?"-"+suffix:"-导出")+".rtl";
  }
  // 保持整行长度与右对齐：值变短就补空格，变长就从值前的空格里吃掉（只吃空格，不动数字）
  function fitPrefix(prefix,delta){
    if(delta>0)return prefix+new Array(delta+1).join(" ");
    if(delta<0){
      var need=-delta,tail=/ +$/.exec(prefix);
      if(tail&&tail[0].length>=need)return prefix.slice(0,prefix.length-need);
      if(tail)return prefix.slice(0,prefix.length-tail[0].length);
    }
    return prefix;
  }
  // 该行导出后应写的值：标准补偿数值（第 1 次测量）的原值（已禁用平均补偿数值）
  function exportValueFor(deviation){
    return state.inverted?invertValue(deviation.value):deviation.value;
  }
  function buildExportText(){
    if(!state.parsed||!state.raw)return "";
    var lines=state.raw.replace(/^\uFEFF/,"").split(/\r?\n/);
    state.parsed.deviations.forEach(function(d){
      var line=lines[d.line];
      if(line==null)return;
      var m=/^(\s*\d+\s+\d+\s+)(-?[\d.]+)(\s*)$/.exec(line);
      if(!m)return;
      var next=exportValueFor(d);
      if(next==null)return;
      lines[d.line]=fitPrefix(m[1],m[2].length-next.length)+next+m[3];
    });
    return lines.join("\r\n");
  }
  function downloadBlob(blob,filename){
    var url=URL.createObjectURL(blob);
    var a=document.createElement("a");
    a.href=url;a.download=filename;
    document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(url);if(a.parentNode)a.parentNode.removeChild(a);},1500);
    setStatus("已生成 "+filename+"（在浏览器下载目录）");
  }
  function deliver(text,filename){
    var blob=new Blob([text],{type:"text/plain;charset=utf-8"});
    if(window.showSaveFilePicker){   // 优先让用户自己选保存位置；取消或不可用则退回默认下载
      try{
        window.showSaveFilePicker({suggestedName:filename,types:[{description:"补偿文件",accept:{"text/plain":[".rtl"]}}]})
          .then(function(handle){return handle.createWritable().then(function(w){return w.write(blob).then(function(){return w.close();});});})
          .then(function(){setStatus("已保存 "+filename);})
          .catch(function(error){
            if(error&&error.name==="AbortError")return;   // 用户主动取消
            downloadBlob(blob,filename);
          });
        return;
      }catch(error){/* 落到下面的默认下载 */}
    }
    downloadBlob(blob,filename);
  }
  if(exportBtn)exportBtn.addEventListener("click",function(){
    var text=buildExportText();
    if(!text){setStatus("请先打开补偿文件");return;}
    deliver(text,exportName());
  });

  // 测试钩子：便于自动化验证解析与渲染（与 window.__databaseRefresh 同一思路）
  window.__compensationLoad=function(text,name){return load(text,name||"(测试文件)");};
  window.__compensationState=function(){return state;};
  window.__compensationExportText=function(){return buildExportText();};
  window.__compensationToggleInvert=function(){if(!state.rows.length)return false;state.inverted=!state.inverted;updateState();return state.inverted;};
  window.__compensationChartSvg=function(){var h2=document.getElementById("comp-chart");return h2?h2.innerHTML:"";};
})();

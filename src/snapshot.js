// Ported from browser-use/jev-ultrafast at commit 452c1ad2 under the MIT License.
(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['file','hidden'].includes(e.type);
  const sensitive = e => e.type === 'password';
  const stateValue = e => sensitive(e) ? Boolean(e.value) : e.value;
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel','password'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  const scrollContainers = () =>
    [...document.querySelectorAll('*')].filter(e =>
      e !== document.scrollingElement &&
      visible(e) &&
      /^(auto|scroll)$/.test(getComputedStyle(e).overflowY) &&
      e.clientHeight > 0 &&
      e.scrollHeight > e.clientHeight + 2
    );
  cache.scrollPoint = (e, delta) => {
    if (!e?.isConnected || !visible(e)) return null;
    if (delta > 0
      ? e.scrollTop + e.clientHeight >= e.scrollHeight - 2
      : e.scrollTop <= 0) return null;
    const r = e.getBoundingClientRect();
    let left = Math.max(0, r.left);
    let right = Math.min(innerWidth, r.right);
    let top = Math.max(0, r.top);
    let bottom = Math.min(innerHeight, r.bottom);
    for (let p = e.parentElement; p; p = p.parentElement) {
      if (p === document.body || p === document.documentElement) continue;
      const style = getComputedStyle(p);
      const bounds = p.getBoundingClientRect();
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    if (right - left < 4 || bottom - top < 4) return null;
    for (const fraction of [0.5, 0.9, 0.1]) {
      const point = {
        x: left + (right - left) * fraction,
        y: top + (bottom - top) / 2,
      };
      let hit = document.elementFromPoint(point.x, point.y);
      if (!hit || !e.contains(hit)) continue;
      while (hit && hit !== e) {
        if (
          /^(auto|scroll)$/.test(getComputedStyle(hit).overflowY) &&
          hit.scrollHeight > hit.clientHeight + 2
        ) break;
        hit = hit.parentElement;
      }
      if (hit === e) return point;
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),stateValue(e),e.checked,e.selectedIndex,e.disabled,e.readOnly]),
    scrollContainers().map(e=>[
      identity(e),e.scrollTop,e.scrollLeft,e.clientHeight,e.scrollHeight
    ])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),sensitive(e)?Boolean(e.value):e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||'',
      e.scrollTop,e.scrollLeft,e.clientHeight,e.scrollHeight];
  };
  const actions=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const hit=document.elementFromPoint(x,y);
    const coveredBy=hit && !e.contains(hit) && !hit.contains(e) ?
      {tag:hit.tagName.toLowerCase(),text:(hit.innerText||hit.getAttribute('aria-label')||'').trim().slice(0,160),role:hit.getAttribute('role')} : null;
    const region=e.closest('form,dialog,[role="dialog"],article,section,li,tr,[role="row"],main,nav,header,footer');
    const nearbyText=(region?.innerText||e.parentElement?.innerText||'').trim().replace(/\s+/g,' ').slice(0,240);
    const base={node:identity(e),role:rname,label:name(e)||rname,...(sensitive(e)?{sensitive:true}:{}),
      rect:{x:r.x,y:r.y,w:r.width,h:r.height},frameUrl:location.href,
      nearbyText,region:region?.getAttribute('aria-label')||region?.getAttribute('role')||region?.tagName.toLowerCase()||'',
      clickable:!coveredBy,coveredBy};
    for (const key of ['checked','selected','expanded','pressed']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? (sensitive(e) ? (e.value ? '[set]' : '') : String(e.value)) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  const roots=[document.body], shadowRoots=[];
  for (const root of roots) for (const e of root.querySelectorAll('*')) {
    if (e.shadowRoot) { roots.push(e.shadowRoot); shadowRoots.push(e.shadowRoot); }
  }
  const words=[], range=document.createRange(); let length=0;
  for (const root of [...shadowRoots,document.body]) {
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); let node;
    while ((node=walker.nextNode()) && length<6000) {
      const value=node.textContent.trim(), parent=node.parentElement;
      if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
      range.selectNodeContents(node); const r=range.getBoundingClientRect();
      if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
        words.push(value); length+=value.length;
      }
    }
  }
  for (const e of scrollContainers()) {
    const label =
      e.getAttribute('aria-label') ||
      e.closest('form,dialog,[role="dialog"]')
        ?.querySelector('h1,h2,h3')?.textContent ||
      'panel';
    for (const delta of [560, -560]) {
      const point = cache.scrollPoint(e, delta);
      if (!point) continue;
      actions.push({
        kind: 'scroll',
        node: identity(e),
        label: 'Scroll ' + (delta > 0 ? 'down' : 'up') +
          ' in ' + label.trim().slice(0, 80),
        delta,
        point,
        rect: { x: point.x - 1, y: point.y - 1, w: 2, h: 2 },
        clickable: true,
        coveredBy: null,
        scrollTop: e.scrollTop,
      });
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6],page_key[7]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()

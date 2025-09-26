document.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  // ---------------- Data URLs ----------------
  const URLS = {
    trees:   'pmtiles://trees.pmtiles',
    fellings:'pmtiles://fellings.pmtiles',
    nbhd:    './tiles/nbhd_stats.geojson'
  };

  // PMTiles protocol for MapLibre
  if (typeof pmtiles !== 'undefined') {
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
  }

  // ------------- Helpers -------------
  function flattenPoints(fc) {
    if (!fc || !fc.features) return { type:'FeatureCollection', features: [] };
    const out = [];
    for (const f of fc.features) {
      const g = f && f.geometry;
      if (!g) continue;
      if (g.type === 'Point') {
        const [x,y] = g.coordinates || [];
        if (isFinite(x)&&isFinite(y)) out.push(f);
      } else if (g.type === 'MultiPoint') {
        for (const c of g.coordinates || []) {
          if (!Array.isArray(c)) continue;
          const [x,y]=c; if (!isFinite(x)||!isFinite(y)) continue;
          out.push({ type:'Feature', properties:{...(f.properties||{})}, geometry:{ type:'Point', coordinates:[x,y] }});
        }
      } else if (g.type === 'GeometryCollection') {
        for (const gg of g.geometries || []) {
          if (!gg || gg.type !== 'Point') continue;
          const [x,y] = gg.coordinates || [];
          if (isFinite(x)&&isFinite(y)) out.push({ type:'Feature', properties:{...(f.properties||{})}, geometry:gg });
        }
      }
    }
    return { type:'FeatureCollection', features: out };
  }

  async function preload(url, name){
    try{
      if (String(url).startsWith('pmtiles://')) return null;
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      const gj = await res.json();
      console.log('[load]', name + ':', gj?.features?.length || 'n/a');
      return gj;
    }catch(e){
      console.error('[load-error]', name, e);
      return null;
    }
  }

  function boundsFromPoints(fc){
    if (!fc?.features?.length) return null;
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (const f of fc.features){
      const g=f.geometry; if (!g || g.type!=='Point') continue;
      const [x,y]=g.coordinates; if (!isFinite(x)||!isFinite(y)) continue;
      if (x<minX)minX=x; if (y<minY)minY=y; if (x>maxX)maxX=x; if (y>maxY)maxY=y;
    }
    if (!isFinite(minX)) return null;
    return [[minX,minY],[maxX,maxY]];
  }

  // ------------ Load data -------------
  const [rawTrees, rawFell, rawNbhd] = await Promise.all([
    preload(URLS.trees, 'trees'),
    preload(URLS.fellings, 'fellings'),
    preload(URLS.nbhd, 'nbhd')
  ]);
  // Keep originals for client-side filtering
  const treesAll = flattenPoints(rawTrees || {type:'FeatureCollection',features:[]});
  const fellAll  = flattenPoints(rawFell  || {type:'FeatureCollection',features:[]});
  // Mutable currently-displayed FeatureCollections
  let treesFC = treesAll;
  let fellFC  = fellAll;
  let activeSpecies = null;

  // ---------------- Map init ----------------
  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        // Pale basemap
        'basemap': {
          type: 'raster',
          tiles: ['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution:
            '© OpenStreetMap © CARTO'
        }
      },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
    },
    center: [-73.60, 45.52],
    zoom: 10.5
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass:false }), 'top-left');

  // ---- Styling helpers: livability legend ----
  function gradientStops(metric){
    if (metric === 'heat') {
      return [
        [1, '#cbe6ff'], // very cool/light blue
        [2, '#a8d4ff'],
        [3, '#ffd966'], // yellow
        [4, '#ffb84d'], // orange
        [5, '#ff704d']  // red
      ];
    } else if (metric === 'noise_eq') {
      return [
        [50, '#cbe6ff'],
        [55, '#a8d4ff'],
        [60, '#ffd966'],
        [65, '#ffb84d'],
        [70, '#ff704d']
      ];
    } else if (metric === 'noise_p50') {
      return [
        [45, '#cbe6ff'],
        [50, '#a8d4ff'],
        [55, '#ffd966'],
        [60, '#ffb84d'],
        [65, '#ff704d']
      ];
    } else { // pm25
      return [
        [4, '#cbe6ff'],
        [6, '#a8d4ff'],
        [8, '#ffd966'],
        [10,'#ffb84d'],
        [12,'#ff704d']
      ];
    }
  }
  function setLegend(metric){
    const stops = gradientStops(metric);
    const legend = $('legend');
    legend.innerHTML = '';
    for (const [val,color] of stops){
      const item = document.createElement('div');
      item.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = color;
      const tx = document.createElement('span');
      tx.textContent = val;
      item.appendChild(sw); item.appendChild(tx);
      legend.appendChild(item);
    }
  }
  function updateLegendEdgeLabels(on){
    const low = $('legend-low'), high = $('legend-high');
    if (!low || !high) return;
    low.style.visibility = on ? 'visible' : 'hidden';
    high.style.visibility = on ? 'visible' : 'hidden';
  }

  // ---------- UI init ----------
  (function initUI(){
    const title = $('title-text');
    if (title) title.textContent = 'Montreal Urban Forest';

    // language default
    const langSel = $('lang-select');
    if (langSel) langSel.value = 'en';
  })();

  // ---------- Map load ----------
  map.on('load', () => {
    // NBHD underlay
    const nbhdInit = rawNbhd ? JSON.parse(JSON.stringify(rawNbhd)) : null;
    if (nbhdInit) { nbhdInit.features.forEach(f => { f.properties.metric = 'heat'; }); }

    map.addSource('nbhd', { type:'geojson', data: nbhdInit || URLS.nbhd });

    map.addLayer({
      id: 'nbhd-fill',
      type: 'fill',
      source: 'nbhd',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'case',
          ['==',['get','metric'],'pm25'],
          ['interpolate',['linear'],['get','pm25'], 4,'#cbe6ff', 6,'#a8d4ff', 8,'#ffd966', 10,'#ffb84d', 12,'#ff704d'],
          ['==',['get','metric'],'noise_eq'],
          ['interpolate',['linear'],['get','noise_eq'], 50,'#cbe6ff', 55,'#a8d4ff', 60,'#ffd966', 65,'#ffb84d', 70,'#ff704d'],
          ['==',['get','metric'],'noise_p50'],
          ['interpolate',['linear'],['get','noise_p50'], 45,'#cbe6ff', 50,'#a8d4ff', 55,'#ffd966', 60,'#ffb84d', 65,'#ff704d'],
          // default heat
          ['interpolate',['linear'],['get','heat'], 1,'#cbe6ff', 2,'#a8d4ff', 3,'#ffd966', 4,'#ffb84d', 5,'#ff704d']
        ],
        'fill-opacity': 0.45
      }
    });
    map.addLayer({
      id: 'nbhd-line',
      type: 'line',
      source: 'nbhd',
      layout: { visibility: 'none' },
      paint: { 'line-color':'#333', 'line-width': 0.5 }
    });

    // Points: trees & fellings
    // Sources (PMTiles vs GeoJSON)
    if (String(URLS.trees).startsWith('pmtiles://')) {
      map.addSource('trees', { type:'vector', url: URLS.trees });
    } else {
      map.addSource('trees', { type:'geojson', data: treesFC, cluster:true, clusterRadius:48, clusterMaxZoom:12 });
    }
    if (String(URLS.fellings).startsWith('pmtiles://')) {
      map.addSource('fellings', { type:'vector', url: URLS.fellings });
    } else {
      map.addSource('fellings', { type:'geojson', data: fellFC,  cluster:true, clusterRadius:48, clusterMaxZoom:12 });
    }

    // Alive clusters
    const trees_clusters_layer = { id: 'trees-clusters',
      type: 'circle',
      source: 'trees',
      filter: ['has','point_count'],
      paint: {
        'circle-color': 'rgba(34,139,34,0.78)',
        'circle-radius': ['step',['get','point_count'], 14, 50, 18, 100, 24, 500, 32],
        'circle-stroke-color': '#1e5e1e',
        'circle-stroke-width': 1
      }
    };
    if (String(URLS.trees).startsWith('pmtiles://')) { trees_clusters_layer['source-layer'] = 'layer0'; }
    map.addLayer(trees_clusters_layer);
    const trees_count_layer = { id: 'trees-count',
      type: 'symbol',
      source: 'trees',
      filter: ['has','point_count'],
      layout: {
        'text-field': ['get','point_count'],
        'text-font': ['Open Sans Regular','Arial Unicode MS Regular'],
        'text-size': 11
      },
      paint: { 'text-color':'#fff', 'text-halo-color':'#1e5e1e', 'text-halo-width':1 }
    };
    if (String(URLS.trees).startsWith('pmtiles://')) { trees_count_layer['source-layer'] = 'layer0'; }
    map.addLayer(trees_count_layer);

    // Alive points
    const trees_points_layer = { id: 'trees-points',
      type: 'circle',
      source: 'trees',
      filter: ['!',['has','point_count']],
      paint: {
        'circle-color': 'rgba(34,139,34,0.38)',
        'circle-radius': ['interpolate',['linear'],['zoom'], 10,2.2, 14,3.6, 16,5],
        'circle-stroke-color': '#228B22',
        'circle-stroke-width': 0.6
      }
    };
    if (String(URLS.trees).startsWith('pmtiles://')) { trees_points_layer['source-layer'] = 'layer0'; }
    map.addLayer(trees_points_layer);

    // Felled clusters
    const fellings_clusters_layer = { id: 'fellings-clusters',
      type: 'circle',
      source: 'fellings',
      filter: ['has','point_count'],
      paint: {
        'circle-color': 'rgba(187,42,52,0.78)',
        'circle-radius': ['step',['get','point_count'], 14, 50, 18, 100, 24, 500, 32],
        'circle-stroke-color': '#7e1f27',
        'circle-stroke-width': 1
      }
    };
    if (String(URLS.fellings).startsWith('pmtiles://')) { fellings_clusters_layer['source-layer'] = 'layer0'; }
    map.addLayer(fellings_clusters_layer);
    const fellings_count_layer = { id: 'fellings-count',
      type: 'symbol',
      source: 'fellings',
      filter: ['has','point_count'],
      layout: {
        'text-field': ['get','point_count'],
        'text-font': ['Open Sans Regular','Arial Unicode MS Regular'],
        'text-size': 11,
        'visibility': 'none'
      },
      paint: { 'text-color':'#fff', 'text-halo-color':'#7e1f27', 'text-halo-width':1 }
    };
    if (String(URLS.fellings).startsWith('pmtiles://')) { fellings_count_layer['source-layer'] = 'layer0'; }
    map.addLayer(fellings_count_layer);

    // Felled points (hidden by default)
    const fellings_points_layer = { id: 'fellings-points',
      type: 'circle',
      source: 'fellings',
      filter: ['!',['has','point_count']],
      layout:{ visibility:'none' },
      paint: {
        'circle-color': 'rgba(187,42,52,0.38)',
        'circle-radius': ['interpolate',['linear'],['zoom'], 10,2.2, 14,3.6, 16,5],
        'circle-stroke-color': '#BB2A34',
        'circle-stroke-width': 0.6
      }
    };
    if (String(URLS.fellings).startsWith('pmtiles://')) { fellings_points_layer['source-layer'] = 'layer0'; }
    map.addLayer(fellings_points_layer);

    // Highlight layer
    map.addSource('highlight', { type:'geojson', data:{ type:'FeatureCollection', features: [] }});
    map.addLayer({
      id: 'highlight',
      type: 'line',
      source: 'highlight',
      paint: {
        'line-color': '#ffa500',
        'line-width': 2
      }
    });

    // Fit bounds if we have points in memory
    const b = boundsFromPoints(treesAll);
    if (b) map.fitBounds(b, { padding: 30, duration: 0 });
  });

  // ---------------- Interactions ----------------
  function setVisibility(layer, on){ if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', on?'visible':'none'); }

  // Neighborhood overlay toggle/metric
  function setNbhdMetric(metric){
    const src = map.getSource('nbhd');
    if (!src) return;
    const fresh = rawNbhd ? JSON.parse(JSON.stringify(rawNbhd)) : null;
    if (fresh) fresh.features.forEach(f=> f.properties.metric = metric);
    src.setData(fresh || URLS.nbhd);
  }
  $('chk-overlay').addEventListener('change', (e)=>{
    const on = e.target.checked;
    setVisibility('nbhd-fill', on);
    setVisibility('nbhd-line', on);
    $('legend').hidden = !on;
    updateLegendEdgeLabels(on);
    if (on) {
      const metric = $('overlay-metric').value;
      setLegend(metric); setNbhdMetric(metric);
    }
  });
  $('overlay-metric').addEventListener('change', (e)=>{
    const metric = e.target.value;
    setLegend(metric); setNbhdMetric(metric);
    const overlayOn = $('chk-overlay')?.checked ?? false;
    updateLegendEdgeLabels(overlayOn);
  });
  setLegend('heat'); $('legend').hidden = true;
  updateLegendEdgeLabels(false);

  // ---------------- Sliders (dual handle) ----------------
  function syncLabel(id, val){ const el=$(id); if (el) el.textContent = String(val); }
  function initYearSliders(){
    const pMin = $('plant-year-min'), pMax=$('plant-year-max');
    const fMin = $('fell-year-min'),  fMax=$('fell-year-max');
    if (pMin&&pMax){ syncLabel('plant-year-min-val', pMin.value); syncLabel('plant-year-max-val', pMax.value); }
    if (fMin&&fMax){ syncLabel('fell-year-min-val',  fMin.value); syncLabel('fell-year-max-val',  fMax.value); }
    [pMin,pMax,fMin,fMax].forEach(inp=>{
      if (!inp) return;
      inp.addEventListener('input', ()=>{
        if (inp===pMin) syncLabel('plant-year-min-val', pMin.value);
        if (inp===pMax) syncLabel('plant-year-max-val', pMax.value);
        if (inp===fMin) syncLabel('fell-year-min-val',  fMin.value);
        if (inp===fMax) syncLabel('fell-year-max-val',  fMax.value);
        applyYearFilters();
      });
    });
  }
  initYearSliders();

  // --------- Click handling (cards) ----------
  map.on('click', 'trees-points', (e)=>{
    const f = e.features && e.features[0]; if (!f) return;
    // highlight
    const src = map.getSource('highlight');
    src.setData({ type:'FeatureCollection', features: [{ type:'Feature', geometry:f.geometry, properties:{} }] });

    // sidebar card
    showTreeCard(f.properties || {}, e.lngLat, 'alive');
  });
  map.on('click', 'fellings-points', (e)=>{
    const f = e.features && e.features[0]; if (!f) return;
    const src = map.getSource('highlight');
    src.setData({ type:'FeatureCollection', features: [{ type:'Feature', geometry:f.geometry, properties:{} }] });
    showTreeCard(f.properties || {}, e.lngLat, 'felled');
  });
  map.on('click', 'nbhd-fill', handleNbhdClick);

  // ---- Hover cursors
  map.on('mouseenter','trees-points', ()=> map.getCanvas().style.cursor='pointer');
  map.on('mouseleave','trees-points', ()=> map.getCanvas().style.cursor='');
  map.on('mouseenter','fellings-points', ()=> map.getCanvas().style.cursor='pointer');
  map.on('mouseleave','fellings-points', ()=> map.getCanvas().style.cursor='');
  map.on('mouseenter','nbhd-fill', ()=> map.getCanvas().style.cursor='pointer');
  map.on('mouseleave','nbhd-fill', ()=> map.getCanvas().style.cursor='');

  // ---------------- Species list & filter ----------------
  function updateSpeciesListUI(){
    const btn = $('species-current');
    if (!btn) return;
    if (activeSpecies) {
      btn.textContent = activeSpecies;
      btn.classList.add('active');
    } else {
      btn.textContent = 'See all species';
      btn.classList.remove('active');
    }
  }

  function filterSpecies(sigle){
    activeSpecies = sigle;
    updateSpeciesListUI();
    if (map.getLayer('trees-points')){
      map.setFilter('trees-points', ['all', ['!',['has','point_count']], ['==', ['get','sigle'], sigle]]);
    }
    if (map.getLayer('fellings-points')){
      map.setFilter('fellings-points', ['all', ['!',['has','point_count']], ['==', ['get','sp_sigle'], sigle]]);
    }
  }

  function resetSpeciesFilter(){
    activeSpecies = null;
    updateSpeciesListUI();
    if (map.getLayer('trees-points')){
      map.setFilter('trees-points', ['!',['has','point_count']]);
    }
    if (map.getLayer('fellings-points')){
      map.setFilter('fellings-points', ['!',['has','point_count']]);
    }
    // Clear highlight and card
    const hl = map.getSource('highlight');
    if (hl) hl.setData({ type:'FeatureCollection', features: [] });
    const card = $('card'); if (card) card.innerHTML = '<p>Select a tree point to see details.</p>';
  }

  function showSpeciesList(){
    const panel = $('species-panel');
    if (!panel) return;
    panel.hidden = false;
    panel.focus();
  }
  function closeSpeciesList(){
    const panel = $('species-panel');
    if (!panel) return;
    panel.hidden = true;
    $('species-current')?.focus();
  }

  function showAllSpecies(){
    const lang = $('lang-select').value;
    const speciesSet = new Set();

    for (const f of treesAll.features){
      const sigle = f.properties?.sigle;
      if (sigle) speciesSet.add(sigle);
    }

    for (const f of fellAll.features){
      const sigle = f.properties?.sp_sigle;
      if (sigle) speciesSet.add(sigle);
    }

    const speciesMap = new Map();
    for (const sigle of speciesSet){
      let name = sigle;
      for (const f of treesAll.features){
        if (f.properties?.sigle === sigle) {
          name = lang === 'fr' ? (f.properties?.essence_fr || f.properties?.essence_ang || sigle)
                               : (f.properties?.essence_ang || f.properties?.essence_fr || sigle);
          break;
        }
      }
      if (name === sigle) {
        for (const f of fellAll.features){
          if (f.properties?.sp_sigle === sigle) {
            name = lang === 'fr' ? (f.properties?.essence_fr || f.properties?.essence_ang || sigle)
                                 : (f.properties?.essence_ang || f.properties?.essence_fr || sigle);
            break;
          }
        }
      }
      speciesMap.set(sigle, name);
    }

    const list = $('species-list');
    list.innerHTML = '';
    const arr = Array.from(speciesMap.entries()).sort((a,b)=> a[1].localeCompare(b[1]));
    for (const [sigle, name] of arr){
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `${name} (${sigle})`;
      btn.addEventListener('click', ()=>{ filterSpecies(sigle); closeSpeciesList(); });
      li.appendChild(btn);
      list.appendChild(li);
    }
    showSpeciesList();
  }

  $('species-current')?.addEventListener('click', showAllSpecies);
  $('species-close')?.addEventListener('click', closeSpeciesList);
  $('species-reset')?.addEventListener('click', ()=>{ resetSpeciesFilter(); closeSpeciesList(); });

  // ---------------- Cards ----------------
  function showTreeCard(props, lngLat, type){
    const card = $('card');
    const t = (en, fr) => ($('lang-select').value === 'fr' ? fr : en);
    const fields = (type==='alive') ? [
      ['Species', 'essence_ang', 'essence_fr'],
      ['Sigle', 'sigle', 'sigle'],
      ['Plant year', 'plant_year', 'plant_year'],
      ['Height (m)', 'hauteur_m', 'hauteur_m']
    ] : [
      ['Species', 'essence_ang', 'essence_fr'],
      ['Sigle', 'sp_sigle', 'sp_sigle'],
      ['Removal year', 'removal_year', 'removal_year'],
      ['Reason', 'cause', 'cause']
    ];
    let html = '<div class="card">';
    html += `<div class="title">${t('Tree','Arbre')} — ${type==='alive'?t('Alive','Vivant'):t('Felled','Abattu')}</div>`;
    html += '<ul>';
    for (const [label, keyEn, keyFr] of fields){
      const val = $('lang-select').value === 'fr' ? (props[keyFr] ?? props[keyEn] ?? '—')
                                                  : (props[keyEn] ?? props[keyFr] ?? '—');
      html += `<li><strong>${t(label, label)}</strong>: ${val}</li>`;
    }
    html += '</ul>';
    html += '</div>';
    card.innerHTML = html;
  }

  function handleNbhdClick(e){
    const f = e.features && e.features[0]; if (!f) return;
    const p = f.properties || {};
    const ll = e.lngLat;
    const lang = $('lang-select').value;
    const t = (en, fr)=> (lang==='fr'?fr:en);
    // highlight by putting polygon border bolder? (simple popup for now)
    let aliveTxt = 'N/A';
    if (p.tree_count != null) aliveTxt = (+p.tree_count < 50) ? t('No data','Pas de données') : String(p.tree_count);

    const html = `
      <div class="card">
        <div class="title">${t('Neighbourhood','Quartier')}</div>
        <ul>
          <li><strong>${t('Trees (alive)','Arbres (vivants)')}</strong>: ${aliveTxt}</li>
          <li><strong>Heat</strong>: ${p.heat ?? '—'}</li>
          <li><strong>Noise LAeq</strong>: ${p.noise_eq ?? '—'}</li>
          <li><strong>Noise LA50</strong>: ${p.noise_p50 ?? '—'}</li>
          <li><strong>PM2.5</strong>: ${p.pm25 ?? '—'}</li>
        </ul>
      </div>`;
    const card = $('card'); card.innerHTML = html;
  }

  // ---------------- Year filtering (w/ clustering) ----------------
  function applyYearFilters(){
    const pMin = +$('plant-year-min').value;
    const pMax = +$('plant-year-max').value;
    const fMin = +$('fell-year-min').value;
    const fMax = +$('fell-year-max').value;

    const usePMTilesTrees = String(URLS.trees).startsWith('pmtiles://');
    const usePMTilesFell  = String(URLS.fellings).startsWith('pmtiles://');

    // Filter features by year
    const treesFilt = treesAll.features.filter(f=>{
      const y = +(f.properties?.plant_year || NaN);
      return isFinite(y) ? (y>=pMin && y<=pMax) : false;
    });
    const fellFilt = fellAll.features.filter(f=>{
      const y = +(f.properties?.removal_year || (String(f.properties?.removal_date||'').slice(0,4)));
      return isFinite(y) ? (y>=fMin && y<=fMax) : false;
    });
    treesFC = { type:'FeatureCollection', features: treesFilt };
    fellFC  = { type:'FeatureCollection', features: fellFilt };

    // Update sources to recompute clusters (GeoJSON only)
    const treesSrc = map.getSource('trees');
    const fellSrc  = map.getSource('fellings');
    if (treesSrc && !usePMTilesTrees) treesSrc.setData(treesFC);
    // If PMTiles, apply layer filter by year
    if (usePMTilesTrees && map.getLayer('trees-points')) {
      map.setFilter('trees-points', ['all', ['!',['has','point_count']],
        ['>=', ['to-number',['get','plant_year']], pMin],
        ['<=', ['to-number',['get','plant_year']], pMax] ]);
    }
    if (fellSrc && !usePMTilesFell)  fellSrc.setData(fellFC);
    if (usePMTilesFell && map.getLayer('fellings-points')) {
      map.setFilter('fellings-points', ['all', ['!',['has','point_count']],
        ['>=', ['to-number',['get','removal_year']], fMin],
        ['<=', ['to-number',['get','removal_year']], fMax] ]);
    }
  }

  // ---------------- Attribution from CSV ----------------
  async function loadAttribution(){
    try{
      const res = await fetch('./dataset_sum.csv');
      if (!res.ok) return;
      const text = await res.text();
      const rows = text.trim().split(/\r?\n/).map(r=>r.split(','));
      if (rows.length<=1) return;
      const [header,...data] = rows;
      const body = $('attrib-body'); if (!body) return;
      const ul = document.createElement('ul');
      ul.className = 'bullets';
      data.forEach(cells=>{
        const li = document.createElement('li');
        li.textContent = cells.join(' — ');
        ul.appendChild(li);
      });
      body.innerHTML = '';
      body.appendChild(ul);
    }catch(e){
      // silent
    }
  }

  // ---------- Controls wiring ----------
  $('trees-on')?.addEventListener('change', (e)=>{
    const on = e.target.checked;
    setVisibility('trees-points', on);
    setVisibility('trees-clusters', on);
    setVisibility('trees-count', on);
  });
  $('fell-on')?.addEventListener('change', (e)=>{
    const on = e.target.checked;
    setVisibility('fellings-points', on);
    setVisibility('fellings-clusters', on);
    setVisibility('fellings-count', on);
  });

  // Language
  $('lang-select')?.addEventListener('change', ()=>{
    const lang = $('lang-select').value;
    // Update labels in species header
    const speciesHeaderTitle = document.querySelector('.species-header .title');
    if (speciesHeaderTitle) speciesHeaderTitle.textContent = lang === 'fr' ? 'Toutes les especes' : 'All Species';
    const speciesCloseBtn = document.querySelector('.species-close');
    if (speciesCloseBtn) speciesCloseBtn.setAttribute('aria-label', lang === 'fr' ? 'Fermer la liste' : 'Close list');
    const overlayMetric = $('overlay-metric');
    if (overlayMetric) {
      overlayMetric.options[0].text = lang === 'fr' ? 'Chaleur (1–5)' : 'Heat (1–5)';
      overlayMetric.options[1].text = 'Noise LAeq (dB)';
      overlayMetric.options[2].text = 'Noise LA50 (dB)';
      overlayMetric.options[3].text = 'PM2.5 (µg/m³)';
    }
    // Refresh legend language
    const metricVal = $('overlay-metric')?.value || 'heat';
    setLegend(metricVal);
    updateLegendEdgeLabels($('chk-overlay')?.checked ?? false);
  });

  // Init
  applyYearFilters();
  loadAttribution();
});

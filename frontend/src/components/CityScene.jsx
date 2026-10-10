import { ArrowUpRight, Camera, Leaf } from 'lucide-react'

export default function CityScene() {
  return <div className="city-scene" aria-label="Illustration of a greener neighborhood">
    <div className="scene-orbit orbit-a"/><div className="scene-orbit orbit-b"/>
    <div className="scene-caption"><span/> A BETTER BLOCK STARTS WITH YOU</div>
    <svg viewBox="0 0 520 420" className="city-art" fill="none" aria-hidden="true">
      <defs><linearGradient id="scene-ground" x1="60" y1="240" x2="390" y2="430" gradientUnits="userSpaceOnUse"><stop stopColor="#C4EE8C"/><stop offset="1" stopColor="#7AAC76"/></linearGradient></defs>
      <circle cx="326" cy="133" r="100" fill="#D9F3BB" opacity=".12"/>
      <circle className="scene-sun" cx="403" cy="103" r="30" fill="#F8CF72"/>
      <path d="m42 295 213-110 224 109-214 112L42 295Z" fill="url(#scene-ground)"/>
      <path d="M42 295v20l223 111v-20L42 295Z" fill="#658A63"/><path d="m265 406 214-112v20L265 426v-20Z" fill="#4E7557"/>
      <path d="m65 301 89-45 210 104-91 47L65 301Z" fill="#E6EDDD"/>
      <path d="m94 306 18-9m26 33 18-9m26 33 18-9m26 33 18-9" stroke="#8DAD84" strokeWidth="3" strokeLinecap="round"/>
      <g className="scene-building"><path d="m157 129 68-35 68 34-68 35-68-34Z" fill="#DEE9C8"/><path d="M157 129v128l68 34V163l-68-34Z" fill="#91AC8B"/><path d="m225 163 68-35v130l-68 33V163Z" fill="#BDD1A7"/>
      <path d="m169 156 14 7v21l-14-7v-21Zm27 14 14 7v21l-14-7v-21Zm-27 30 14 7v21l-14-7v-21Zm27 14 14 7v21l-14-7v-21Z" fill="#DDF3D1"/><path d="m239 166 14-7v21l-14 7v-21Zm26-13 14-7v21l-14 7v-21Zm-26 55 14-7v21l-14 7v-21Zm26-13 14-7v21l-14 7v-21Z" fill="#526E60"/>
      <path d="M239 247v30l20-10v-30l-20 10Z" fill="#42604E"/><path d="m152 128 73-38 74 38" stroke="#ECF5DD" strokeWidth="7" strokeLinecap="round"/></g>
      <g className="scene-tree tree-one"><ellipse cx="99" cy="275" rx="28" ry="12" fill="#60885D" opacity=".25"/><path d="M99 264v-76" stroke="#D2DFBC" strokeWidth="9" strokeLinecap="round"/><path d="M65 195c0-25 13-52 34-52s35 27 35 52-17 38-35 38-34-13-34-38Z" fill="#B8E874"/><path d="M99 169v61m0-26 17-18m-17 6-15-13" stroke="#82B65C" strokeWidth="3" strokeLinecap="round"/></g>
      <g className="scene-tree tree-two"><ellipse cx="361" cy="264" rx="34" ry="13" fill="#60885D" opacity=".25"/><path d="M361 254v-73" stroke="#D2DFBC" strokeWidth="10" strokeLinecap="round"/><path d="M324 182c0-31 15-57 37-57s37 26 37 57-18 44-37 44-37-13-37-44Z" fill="#70B17D"/><path d="M361 151v71m0-30 19-18m-19 27-18-21" stroke="#A1D7A5" strokeWidth="3" strokeLinecap="round"/></g>
      <g className="scene-bin"><ellipse cx="330" cy="321" rx="23" ry="10" fill="#63895B" opacity=".3"/><path d="m308 261 23-12 22 12-23 12-22-12Z" fill="#E4FF96"/><path d="m308 261 3 45 20 11v-44l-23-12Z" fill="#A2D95B"/><path d="m331 273 22-12-3 45-19 11v-44Z" fill="#5E9A55"/><path d="m308 258 22-12 24 12v7l-24 12-22-12v-7Z" fill="#D2F887"/><path d="m319 281 8 4v10l-8-4v-10Z" fill="#EFFFD4"/></g>
      <g className="scene-person"><ellipse cx="202" cy="331" rx="23" ry="9" fill="#60885D" opacity=".22"/><path d="m197 286-8 38m18-37 5 37" stroke="#213C37" strokeWidth="9" strokeLinecap="round"/><path d="M192 258c0-10 7-14 14-14s12 6 12 16l-3 31h-23v-33Z" fill="#E9BB69"/><circle cx="205" cy="234" r="11" fill="#E8D0B2"/><path d="M194 233c-1-8 5-13 13-12 7 0 11 6 10 12l-9-5-14 5Z" fill="#213C37"/><path d="m215 257 20 18m-40-17-13 22" stroke="#E8D0B2" strokeWidth="7" strokeLinecap="round"/><rect x="227" y="262" width="12" height="19" rx="3" fill="#263E37" transform="rotate(-12 227 262)"/></g>
      <path d="m413 279 10-5m-22 18 10-5m-260 40 10-5" stroke="#F4F9E8" strokeWidth="3" strokeLinecap="round"/>
    </svg>
    <div className="scene-note scene-note-photo"><span><Camera size={18}/></span><div><b>See it. Snap it.</b><small>Turn a sighting into a next step.</small></div><ArrowUpRight size={17}/></div>
    <div className="scene-note scene-note-leaf"><Leaf size={17}/><span>Small acts. Cleaner streets.</span></div>
    <span className="scene-star star-a">✳</span><span className="scene-star star-b">+</span>
  </div>
}

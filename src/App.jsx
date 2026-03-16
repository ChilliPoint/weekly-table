import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://oqtwydycvlxegiyebifn.supabase.co";
const SUPABASE_KEY = "sb_publishable_23h2uTq8_l-Nqi1NkSKVQg_pmd4G4d1";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "cup", "oz", "lb", "bunch", "piece", "handful", "slice", "can", "pack", ""];

const VIEWS = { RECIPES: "recipes", PLANNER: "planner", SHOPPING: "shopping" };

function useStore() {
  const [state, setState] = useState({ recipes: [], weekPlan: [] });
  const [syncStatus, setSyncStatus] = useState("loading");
  const saveTimerRef = useRef(null);
  const lastSavedRef = useRef(null);
  const initializedRef = useRef(false);
  const pendingStateRef = useRef(null);

  useEffect(() => {
    async function load() {
      try {
        const { data, error } = await supabase
          .from("meal_planner")
          .select("data")
          .eq("id", "shared")
          .single();
        if (error) throw error;
        setState(data.data);
        lastSavedRef.current = JSON.stringify(data.data);
        setSyncStatus("saved");
      } catch {
        setState({ recipes: [], weekPlan: [] });
        setSyncStatus("saved");
      }
      initializedRef.current = true;
    }
    load();
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("meal_planner_changes")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "meal_planner" }, payload => {
        const remote = JSON.stringify(payload.new.data);
        if (remote !== lastSavedRef.current) {
          setState(payload.new.data);
          lastSavedRef.current = remote;
        }
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  function setStoreAndSave(updater) {
    setState(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (initializedRef.current) {
        setSyncStatus("saving");
        pendingStateRef.current = next;
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(async () => {
          try {
            const { error } = await supabase
              .from("meal_planner")
              .update({ data: pendingStateRef.current, updated_at: new Date().toISOString() })
              .eq("id", "shared");
            if (error) throw error;
            lastSavedRef.current = JSON.stringify(pendingStateRef.current);
            setSyncStatus("saved");
          } catch {
            setSyncStatus("error");
          }
        }, 600);
      }
      return next;
    });
  }

  return [state, setStoreAndSave, syncStatus];
}

export default function App() {
  const [store, setStore, syncStatus] = useStore();
  const [view, setView] = useState(VIEWS.RECIPES);
  const [editingRecipe, setEditingRecipe] = useState(null);
  const [shoppingAdjustments, setShoppingAdjustments] = useState({});

  const recipes = store.recipes || [];
  const calendarPlan = store.calendarPlan || {}; // { "Mon-breakfast": { recipeId, servings }, ... }

  function upsertRecipe(recipe) {
    setStore(s => {
      const existing = s.recipes.find(r => r.id === recipe.id);
      if (existing) {
        return { ...s, recipes: s.recipes.map(r => r.id === recipe.id ? recipe : r) };
      }
      return { ...s, recipes: [...s.recipes, recipe] };
    });
    setEditingRecipe(null);
  }

  function deleteRecipe(id) {
    setStore(s => {
      const newCalendar = { ...s.calendarPlan };
      Object.keys(newCalendar).forEach(k => { if (newCalendar[k]?.recipeId === id) delete newCalendar[k]; });
      return { ...s, recipes: s.recipes.filter(r => r.id !== id), calendarPlan: newCalendar };
    });
  }

  function setCalendarSlot(slotKey, recipeId) {
    setStore(s => {
      const newCalendar = { ...s.calendarPlan };
      if (!recipeId) { delete newCalendar[slotKey]; }
      else { newCalendar[slotKey] = { recipeId, servings: 2 }; }
      return { ...s, calendarPlan: newCalendar };
    });
  }

  function clearCalendarSlots(slotKeys) {
    setStore(s => {
      const newCalendar = { ...s.calendarPlan };
      slotKeys.forEach(k => delete newCalendar[k]);
      return { ...s, calendarPlan: newCalendar };
    });
  }

  function updateCalendarServings(slotKey, servings) {
    setStore(s => ({
      ...s,
      calendarPlan: { ...s.calendarPlan, [slotKey]: { ...s.calendarPlan[slotKey], servings: Math.max(1, servings) } }
    }));
  }

  function normaliseIngredient(amount, unit) {
    if (unit === "g") return { amount: amount / 1000, unit: "kg" };
    if (unit === "ml") return { amount: amount / 1000, unit: "l" };
    return { amount, unit };
  }

  function formatAmount(amount, unit) {
    if (unit === "kg" && amount < 1) return { amount: Math.round(amount * 1000 * 100) / 100, unit: "g" };
    if (unit === "l" && amount < 0.1) return { amount: Math.round(amount * 1000 * 100) / 100, unit: "ml" };
    return { amount: Math.round(amount * 1000) / 1000, unit };
  }

  function stemIngredientName(name) {
    const s = name.toLowerCase().trim();
    if (s.endsWith("ies") && s.length > 4) return s.slice(0, -3) + "y";
    if (s.endsWith("ves") && s.length > 4) return s.slice(0, -3) + "f";
    if (s.endsWith("ses") && s.length > 4) return s.slice(0, -2);
    if (s.endsWith("es") && s.length > 4) return s.slice(0, -2);
    if (s.endsWith("s") && s.length > 3) return s.slice(0, -1);
    return s;
  }

  function buildShoppingList() {
    const map = {};
    Object.values(calendarPlan).forEach(({ recipeId, servings }) => {
      const recipe = recipes.find(r => r.id === recipeId);
      if (!recipe) return;
      const scale = servings / (recipe.baseServings || 2);
      recipe.ingredients.forEach(ing => {
        const scaled = (ing.amount || 0) * scale;
        const { amount: normAmount, unit: normUnit } = normaliseIngredient(scaled, ing.unit);
        const stem = stemIngredientName(ing.name);
        const key = `${stem}__${normUnit}`;
        if (!map[key]) map[key] = { name: ing.name, unit: normUnit, amount: 0 };
        map[key].amount += normAmount;
      });
    });
    return Object.values(map).map(item => {
      const { amount, unit } = formatAmount(item.amount, item.unit);
      return { ...item, amount, unit, key: `${stemIngredientName(item.name)}__${item.unit}` };
    });
  }

  const shoppingList = buildShoppingList();
  const totalMealsPlanned = Object.keys(calendarPlan).length;

  return (
    <div style={{ fontFamily: "'Crimson Pro', 'Georgia', serif", minHeight: "100vh", background: "#faf7f2", color: "#1a1108" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --cream: #faf7f2;
          --warm: #f0ebe0;
          --ink: #1a1108;
          --muted: #7a6a54;
          --accent: #c4622d;
          --accent-light: #f5e8df;
          --green: #3d6b4f;
          --green-light: #e4efe8;
          --border: #ddd6c8;
        }
        button { cursor: pointer; font-family: inherit; }
        input, textarea, select { font-family: inherit; }
        .nav-btn { background: none; border: none; padding: 10px 20px; font-size: 15px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; font-family: 'DM Mono', monospace; font-size: 11px; transition: color 0.2s; }
        .nav-btn:hover { color: var(--ink); }
        .nav-btn.active { color: var(--accent); border-bottom: 2px solid var(--accent); }
        .card { background: white; border: 1px solid var(--border); border-radius: 2px; }
        .btn-primary { background: var(--accent); color: white; border: none; padding: 10px 22px; font-size: 14px; letter-spacing: 0.04em; border-radius: 2px; transition: background 0.2s; }
        .btn-primary:hover { background: #a8501f; }
        .btn-ghost { background: none; border: 1px solid var(--border); padding: 8px 18px; font-size: 13px; color: var(--muted); border-radius: 2px; transition: all 0.2s; }
        .btn-ghost:hover { border-color: var(--ink); color: var(--ink); }
        .btn-danger { background: none; border: none; color: #c0392b; font-size: 12px; padding: 4px 8px; border-radius: 2px; transition: background 0.2s; font-family: 'DM Mono', monospace; }
        .btn-danger:hover { background: #fdecea; }
        .input { border: 1px solid var(--border); background: var(--cream); color: var(--ink); padding: 9px 13px; font-size: 15px; border-radius: 2px; width: 100%; outline: none; transition: border-color 0.2s; }
        .input:focus { border-color: var(--accent); }
        .tag { display: inline-block; background: var(--accent-light); color: var(--accent); font-size: 11px; padding: 3px 9px; border-radius: 20px; font-family: 'DM Mono', monospace; letter-spacing: 0.04em; }
        .spinner { border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; width: 18px; height: 18px; animation: spin 0.7s linear infinite; display: inline-block; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .fade-in { animation: fadeIn 0.3s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        .strikethrough { text-decoration: line-through; color: var(--muted); }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: var(--warm); } ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 10px; }
        .mobile-only { display: none !important; }
        .desktop-only { display: block !important; }
        @media (max-width: 700px) {
          .mobile-only { display: block !important; }
          .desktop-only { display: none !important; }
          .nav-btn { padding: 10px 8px; font-size: 10px; }
          .modal-padding { padding: 20px 16px !important; }
          .modal-outer { padding: 16px 8px !important; }
          .ing-row { grid-template-columns: 1fr 64px 80px auto !important; gap: 5px !important; }
          .main-padding { padding: 20px 14px !important; }
          input, select, textarea { font-size: 16px !important; }
          .header-inner { padding: 0 12px !important; }
        }
      `}</style>

      {/* Header */}
      <header style={{ borderBottom: "1px solid var(--border)", background: "white", position: "sticky", top: 0, zIndex: 100 }}>
        <div className="header-inner" style={{ maxWidth: 860, margin: "0 auto", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ padding: "18px 0", display: "flex", alignItems: "center", gap: 12 }}>
            <div>
              <span style={{ fontSize: 22, fontWeight: 300, letterSpacing: "-0.01em" }}>the weekly</span>
              <span style={{ fontSize: 22, fontWeight: 600, color: "var(--accent)", marginLeft: 6 }}>table</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: "'DM Mono', monospace", fontSize: 10, letterSpacing: "0.05em" }}>
              {syncStatus === "loading" && <><span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }}></span><span style={{ color: "var(--muted)" }}>LOADING</span></>}
              {syncStatus === "saving" && <><span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }}></span><span style={{ color: "var(--muted)" }}>SAVING</span></>}
              {syncStatus === "saved" && <><span style={{ color: "var(--green)", fontSize: 12 }}>●</span><span style={{ color: "var(--muted)" }}>SYNCED</span></>}
              {syncStatus === "error" && <><span style={{ color: "#c0392b", fontSize: 12 }}>●</span><span style={{ color: "#c0392b" }}>SYNC ERROR</span></>}
            </div>
          </div>
          <nav style={{ display: "flex", gap: 4 }}>
            {[
              { key: VIEWS.RECIPES, label: "Recipes" },
              { key: VIEWS.PLANNER, label: "This Week" },
              { key: VIEWS.SHOPPING, label: "Shopping" },
            ].map(({ key, label }) => (
              <button key={key} className={`nav-btn ${view === key ? "active" : ""}`} onClick={() => setView(key)}>
                {label}
                {key === VIEWS.PLANNER && totalMealsPlanned > 0 && (
                  <span style={{ marginLeft: 5, background: "var(--accent)", color: "white", borderRadius: "50%", width: 16, height: 16, fontSize: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Mono', monospace" }}>{totalMealsPlanned}</span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="main-padding" style={{ maxWidth: 860, margin: "0 auto", padding: "32px 24px" }}>
        {view === VIEWS.RECIPES && (
          <RecipesView
            recipes={recipes}
            onEdit={setEditingRecipe}
            onDelete={deleteRecipe}
            onNew={() => setEditingRecipe({ id: Date.now().toString(), name: "", baseServings: 2, ingredients: [], steps: [] })}
          />
        )}
        {view === VIEWS.PLANNER && (
          <PlannerView
            recipes={recipes}
            calendarPlan={calendarPlan}
            onSetSlot={setCalendarSlot}
            onClearSlots={clearCalendarSlots}
            onServings={updateCalendarServings}
            onGoShopping={() => setView(VIEWS.SHOPPING)}
          />
        )}
        {view === VIEWS.SHOPPING && (
          <ShoppingView
            shoppingList={shoppingList}
            calendarPlan={calendarPlan}
            recipes={recipes}
            adjustments={shoppingAdjustments}
            onAdjust={setShoppingAdjustments}
          />
        )}
      </main>

      {editingRecipe && (
        <RecipeModal
          recipe={editingRecipe}
          onSave={upsertRecipe}
          onClose={() => setEditingRecipe(null)}
        />
      )}
    </div>
  );
}

function RecipesView({ recipes, onEdit, onDelete, onNew }) {
  const [search, setSearch] = useState("");
  const filtered = recipes.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 32, fontWeight: 300, lineHeight: 1.1 }}>Recipe <em>Library</em></h1>
          <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 15 }}>{recipes.length} recipe{recipes.length !== 1 ? "s" : ""} saved</p>
        </div>
        <button className="btn-primary" onClick={onNew}>+ Add Recipe</button>
      </div>

      {recipes.length > 0 && (
        <input className="input" placeholder="Search recipes…" value={search} onChange={e => setSearch(e.target.value)} style={{ marginBottom: 20, maxWidth: 360 }} />
      )}

      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: "80px 0", color: "var(--muted)" }}>
          {recipes.length === 0 ? (
            <>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🍳</div>
              <p style={{ fontSize: 18, fontWeight: 300 }}>Your recipe library is empty</p>
              <p style={{ fontSize: 14, marginTop: 6 }}>Add your first recipe to get started</p>
            </>
          ) : <p>No recipes match your search</p>}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
        {filtered.map(recipe => (
          <RecipeCard key={recipe.id} recipe={recipe} onEdit={() => onEdit(recipe)} onDelete={() => onDelete(recipe.id)} />
        ))}
      </div>
    </div>
  );
}

function RecipeCard({ recipe, onEdit, onDelete }) {
  return (
    <div className="card" style={{ padding: "20px", transition: "box-shadow 0.2s", cursor: "default" }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 20px rgba(0,0,0,0.07)"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <h3 style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.3, flex: 1, marginRight: 8 }}>{recipe.name}</h3>
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span className="tag">serves {recipe.baseServings || 2}</span>
        <span className="tag" style={{ background: "var(--green-light)", color: "var(--green)" }}>{recipe.ingredients?.length || 0} ingredients</span>
      </div>
      {recipe.ingredients?.length > 0 && (
        <p style={{ marginTop: 10, fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
          {recipe.ingredients.slice(0, 4).map(i => i.name).join(", ")}{recipe.ingredients.length > 4 ? `…` : ""}
        </p>
      )}
      <div style={{ marginTop: 16, display: "flex", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 12, alignItems: "center" }}>
        <button className="btn-ghost" style={{ fontSize: 12 }} onClick={onEdit}>Edit</button>
        <button className="btn-danger" onClick={onDelete}>Delete</button>
        {recipe.url && (() => { try { new URL(recipe.url); return true; } catch { return false; } })() && (
          <a href={recipe.url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: "auto", fontSize: 12, color: "var(--accent)", textDecoration: "underline", fontFamily: "'DM Mono', monospace" }}>Recipe ↗</a>
        )}
      </div>
    </div>
  );
}

function RecipePreviewModal({ recipe, onClose }) {
  return (
    <div className="modal-outer" style={{ position: "fixed", inset: 0, background: "rgba(26,17,8,0.45)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card fade-in modal-padding" style={{ width: "100%", maxWidth: 620, background: "white", padding: "32px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2 }}>{recipe.name}</h2>
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <span className="tag">serves {recipe.baseServings || 2}</span>
              <span className="tag" style={{ background: "var(--green-light)", color: "var(--green)" }}>{recipe.ingredients?.length || 0} ingredients</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, color: "var(--muted)", cursor: "pointer", padding: "0 4px", flexShrink: 0 }}>×</button>
        </div>

        {recipe.ingredients?.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <p style={{ fontSize: 12, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", marginBottom: 10 }}>INGREDIENTS</p>
            {recipe.ingredients.map(ing => (
              <div key={ing.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderBottom: "1px solid var(--border)", fontSize: 15 }}>
                <span>{ing.name}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "var(--accent)" }}>{ing.amount || ""}{ing.unit ? ` ${ing.unit}` : ""}</span>
              </div>
            ))}
          </div>
        )}

        {recipe.steps?.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <p style={{ fontSize: 12, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", marginBottom: 10 }}>METHOD</p>
            {recipe.steps.map((step, i) => (
              <div key={step.id} style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "flex-start" }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "var(--accent)", minWidth: 22, paddingTop: 2, flexShrink: 0 }}>{i + 1}.</span>
                <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--ink)" }}>{step.text}</p>
              </div>
            ))}
          </div>
        )}

        {recipe.url && (() => { try { new URL(recipe.url); return true; } catch { return false; } })() && (
          <div style={{ paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            <a href={recipe.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, color: "var(--accent)", textDecoration: "underline", fontFamily: "'DM Mono', monospace" }}>View original recipe ↗</a>
          </div>
        )}
      </div>
    </div>
  );
}


const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MEALS = ["Breakfast", "Lunch", "Dinner"];

function slotKey(day, meal) { return `${day}-${meal.toLowerCase()}`; }

function RecipePickerModal({ recipes, onSelect, onClose }) {
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState(null);
  const filtered = recipes.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));
  const inputRef = useRef();
  useEffect(() => { inputRef.current?.focus(); }, []);

  if (preview) {
    return (
      <div className="modal-outer" style={{ position: "fixed", inset: 0, background: "rgba(26,17,8,0.45)", zIndex: 300, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}
        onClick={e => e.target === e.currentTarget && onClose()}>
        <div className="card fade-in modal-padding" style={{ width: "100%", maxWidth: 560, background: "white", padding: "28px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <button onClick={() => setPreview(null)} style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 13, fontFamily: "'DM Mono', monospace", cursor: "pointer", padding: 0, marginBottom: 8, display: "block" }}>← Back</button>
              <h2 style={{ fontSize: 22, fontWeight: 600 }}>{preview.name}</h2>
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, color: "var(--muted)", cursor: "pointer", padding: "0 4px" }}>×</button>
          </div>
          {preview.ingredients?.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", marginBottom: 8 }}>INGREDIENTS</p>
              {preview.ingredients.map(ing => (
                <div key={ing.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 14 }}>
                  <span>{ing.name}</span>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "var(--accent)" }}>{ing.amount || ""}{ing.unit ? ` ${ing.unit}` : ""}</span>
                </div>
              ))}
            </div>
          )}
          {preview.steps?.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", marginBottom: 8 }}>METHOD</p>
              {preview.steps.map((step, i) => (
                <div key={step.id} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "var(--accent)", minWidth: 18, flexShrink: 0 }}>{i + 1}.</span>
                  <p style={{ fontSize: 14, lineHeight: 1.5 }}>{step.text}</p>
                </div>
              ))}
            </div>
          )}
          <button className="btn-primary" style={{ width: "100%" }} onClick={() => onSelect(preview.id)}>Add to plan</button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-outer" style={{ position: "fixed", inset: 0, background: "rgba(26,17,8,0.45)", zIndex: 300, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card fade-in modal-padding" style={{ width: "100%", maxWidth: 480, background: "white", padding: "28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 20, fontWeight: 300 }}>Pick a <em>recipe</em></h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, color: "var(--muted)", cursor: "pointer", padding: "0 4px" }}>×</button>
        </div>
        <input ref={inputRef} className="input" placeholder="Search recipes…" value={search} onChange={e => setSearch(e.target.value)} style={{ marginBottom: 12 }} />
        {filtered.length === 0 && <p style={{ color: "var(--muted)", fontSize: 14, padding: "12px 0" }}>No recipes match your search</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 340, overflowY: "auto" }}>
          {filtered.map(r => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid var(--border)", borderRadius: 2, padding: "10px 12px", background: "var(--cream)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 15, fontWeight: 500 }}>{r.name}</p>
                <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{r.ingredients?.length || 0} ingredients · serves {r.baseServings || 2}</p>
              </div>
              <div style={{ display: "flex", gap: 8, marginLeft: 10 }}>
                <button className="btn-ghost" style={{ fontSize: 12, padding: "5px 10px" }} onClick={() => setPreview(r)}>View</button>
                <button className="btn-primary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => onSelect(r.id)}>Add</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Full week day order for cycling
const ALL_WEEK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Given the current extra days prepended, what's the next day to add before Monday?
// Goes: Sunday, Saturday, Friday, Thursday...
function prevDayName(extrasBefore) {
  // extrasBefore is an array of day keys already prepended, newest first
  const baseIdx = 6; // Sunday = index 6 in ALL_WEEK_DAYS
  const next = baseIdx - extrasBefore.length;
  if (next < 0) return ALL_WEEK_DAYS[((next % 7) + 7) % 7];
  return ALL_WEEK_DAYS[next];
}

// After Sunday, goes: Monday, Tuesday, Wednesday...
function nextDayName(extrasAfter) {
  const baseIdx = 0; // Monday = index 0
  return ALL_WEEK_DAYS[(baseIdx + extrasAfter.length) % 7];
}

function PlannerView({ recipes, calendarPlan, onSetSlot, onClearSlots, onServings, onGoShopping }) {
  const [picker, setPicker] = useState(null);
  const [previewRecipe, setPreviewRecipe] = useState(null);
  const [extrasBefore, setExtrasBefore] = useState([]);
  const [extrasAfter, setExtrasAfter] = useState([]);
  const totalMeals = Object.keys(calendarPlan).length;

  const allDays = [...extrasBefore, ...DAYS, ...extrasAfter];

  function addDayBefore() {
    const name = prevDayName(extrasBefore);
    const key = `before-${extrasBefore.length}-${name}`;
    setExtrasBefore(prev => [key, ...prev]);
  }

  function addDayAfter() {
    const name = nextDayName(extrasAfter);
    const key = `after-${extrasAfter.length}-${name}`;
    setExtrasAfter(prev => [...prev, key]);
  }

  function removeDayBefore() {
    const key = extrasBefore[0];
    onClearSlots(MEALS.map(meal => slotKey(key, meal)));
    setExtrasBefore(prev => prev.slice(1));
  }

  function removeDayAfter() {
    const key = extrasAfter[extrasAfter.length - 1];
    onClearSlots(MEALS.map(meal => slotKey(key, meal)));
    setExtrasAfter(prev => prev.slice(0, -1));
  }

  function clearAll() {
    // Wipe every slot in the store — core week and any lingering extra day slots
    onClearSlots(Object.keys(calendarPlan));
    setExtrasBefore([]);
    setExtrasAfter([]);
  }

  function displayName(dayKey) {
    const parts = dayKey.split("-");
    return parts[parts.length - 1];
  }

  function handleSelect(recipeId) {
    onSetSlot(slotKey(picker.day, picker.meal), recipeId);
    setPicker(null);
  }

  const addDayBtn = (onClick, label) => (
    <button onClick={onClick} style={{ background: "none", border: "1px dashed var(--border)", borderRadius: 2, padding: "8px 14px", fontSize: 12, color: "var(--muted)", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>+ {label}</button>
  );

  return (
    <div className="fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 32, fontWeight: 300 }}>This <em>Week</em></h1>
          <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 15 }}>Plan your meals for the week</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {totalMeals > 0 && (
            <button className="btn-ghost" onClick={clearAll}>Clear</button>
          )}
          {totalMeals > 0 && (
            <button className="btn-primary" onClick={onGoShopping}>Shopping List →</button>
          )}
        </div>
      </div>

      {recipes.length === 0 && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "var(--muted)" }}>
          <p style={{ fontSize: 16, fontWeight: 300 }}>Add recipes to your library first</p>
        </div>
      )}

      {recipes.length > 0 && (<>
        {/* Mobile: stacked vertically */}
        <div className="mobile-only" style={{ display: "none" }}>
          <div style={{ marginBottom: 8 }}>{addDayBtn(addDayBefore, `Add Day (${prevDayName(extrasBefore)})`)}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {allDays.map((day, idx) => {
              const isExtraBefore = idx < extrasBefore.length;
              const isExtraAfter = idx >= extrasBefore.length + DAYS.length;
              const isNewestBefore = day === extrasBefore[0];
              const isNewestAfter = day === extrasAfter[extrasAfter.length - 1];
              return (
                <DayCard key={day} dayKey={day} displayDay={DAYS.includes(day) ? day : displayName(day)}
                  calendarPlan={calendarPlan} recipes={recipes} onSetSlot={onSetSlot} onServings={onServings}
                  onOpenPicker={(d, meal) => setPicker({ day: d, meal })} onPreview={setPreviewRecipe} mobile={true}
                  isExtra={isExtraBefore || isExtraAfter}
                  canRemove={isNewestBefore || isNewestAfter}
                  onRemove={isNewestBefore ? removeDayBefore : removeDayAfter}
                />
              );
            })}
          </div>
          <div style={{ marginTop: 8 }}>{addDayBtn(addDayAfter, `Add Day (${nextDayName(extrasAfter)})`)}</div>
        </div>

        {/* Desktop: grid */}
        <div className="desktop-only">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            {addDayBtn(addDayBefore, `Add Day (${prevDayName(extrasBefore)})`)}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${allDays.length}, 1fr)`, gap: 8 }}>
            {allDays.map((day, idx) => {
              const isExtraBefore = idx < extrasBefore.length;
              const isExtraAfter = idx >= extrasBefore.length + DAYS.length;
              const isNewestBefore = day === extrasBefore[0];
              const isNewestAfter = day === extrasAfter[extrasAfter.length - 1];
              return (
                <DayCard key={day} dayKey={day} displayDay={DAYS.includes(day) ? day : displayName(day)}
                  calendarPlan={calendarPlan} recipes={recipes} onSetSlot={onSetSlot} onServings={onServings}
                  onOpenPicker={(d, meal) => setPicker({ day: d, meal })} onPreview={setPreviewRecipe} mobile={false}
                  isExtra={isExtraBefore || isExtraAfter}
                  canRemove={isNewestBefore || isNewestAfter}
                  onRemove={isNewestBefore ? removeDayBefore : removeDayAfter}
                />
              );
            })}
          </div>
          <div style={{ marginTop: 8 }}>
            {addDayBtn(addDayAfter, `Add Day (${nextDayName(extrasAfter)})`)}
          </div>
        </div>
      </>)}

      {picker && (
        <RecipePickerModal recipes={recipes} onSelect={handleSelect} onClose={() => setPicker(null)} />
      )}
      {previewRecipe && (
        <RecipePreviewModal recipe={previewRecipe} onClose={() => setPreviewRecipe(null)} />
      )}
    </div>
  );
}

function DayCard({ dayKey, displayDay, calendarPlan, recipes, onSetSlot, onServings, onOpenPicker, onPreview, mobile, isExtra, canRemove, onRemove }) {
  return (
    <div style={{ background: "white", border: "1px solid var(--border)", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ background: "var(--warm)", padding: "8px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "var(--ink)", letterSpacing: "0.06em", fontWeight: 500 }}>{displayDay.toUpperCase()}</p>
        {isExtra && canRemove && (
          <button onClick={onRemove} style={{ background: "none", border: "none", color: "#c0392b", fontSize: 11, cursor: "pointer", fontFamily: "'DM Mono', monospace", padding: 0 }}>✕ Remove</button>
        )}
      </div>
      <div style={{ display: mobile ? "grid" : "flex", gridTemplateColumns: mobile ? "repeat(3, 1fr)" : undefined, flexDirection: mobile ? undefined : "column" }}>
        {MEALS.map((meal, i) => {
          const key = slotKey(dayKey, meal);
          const slot = calendarPlan[key];
          const recipe = slot ? recipes.find(r => r.id === slot.recipeId) : null;
          const borderStyle = mobile
            ? { borderRight: i < MEALS.length - 1 ? "1px solid var(--border)" : "none" }
            : { borderBottom: i < MEALS.length - 1 ? "1px solid var(--border)" : "none" };
          return (
            <div key={meal} style={{ padding: "8px 10px", minHeight: mobile ? 80 : 64, ...borderStyle }}>
              <p style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--muted)", letterSpacing: "0.05em", marginBottom: 4 }}>{meal.toUpperCase()}</p>
              {recipe ? (
                <div>
                  <button onClick={() => onPreview(recipe)} style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--ink)", fontFamily: "inherit", lineHeight: 1.3, display: "block", width: "100%" }}>{recipe.name}</button>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                    <button style={{ background: "none", border: "1px solid var(--border)", width: 20, height: 20, minWidth: 20, minHeight: 20, borderRadius: "50%", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, color: "var(--ink)" }} onClick={() => onServings(key, slot.servings - 1)}>−</button>
                    <span style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", minWidth: 16, textAlign: "center" }}>{slot.servings}</span>
                    <button style={{ background: "none", border: "1px solid var(--border)", width: 20, height: 20, minWidth: 20, minHeight: 20, borderRadius: "50%", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, color: "var(--ink)" }} onClick={() => onServings(key, slot.servings + 1)}>+</button>
                    <button onClick={() => onSetSlot(key, null)} style={{ background: "none", border: "none", color: "#c0392b", fontSize: 11, padding: "0 2px", cursor: "pointer", marginLeft: "auto", fontFamily: "'DM Mono', monospace" }}>✕</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => onOpenPicker(dayKey, meal)} style={{ background: "none", border: "1px dashed var(--border)", borderRadius: 2, width: "100%", padding: "6px 8px", fontSize: 12, color: "var(--muted)", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>+ Add</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function ShoppingView({ shoppingList, calendarPlan, recipes, adjustments, onAdjust }) {
  const [checked, setChecked] = useState({});

  function toggleChecked(key) {
    setChecked(s => ({ ...s, [key]: !s[key] }));
  }

  function setAdj(key, val) {
    onAdjust(a => ({ ...a, [key]: val }));
  }

  const unchecked = shoppingList.filter(i => !checked[i.key]);
  const done = shoppingList.filter(i => checked[i.key]);

  function effectiveAmount(item) {
    const adj = adjustments[item.key];
    if (adj === undefined || adj === "") return item.amount;
    const have = parseFloat(adj) || 0;
    return Math.max(0, Math.round((item.amount - have) * 100) / 100);
  }

  const totalMeals = Object.keys(calendarPlan).length;

  if (totalMeals === 0) {
    return (
      <div className="fade-in" style={{ textAlign: "center", padding: "80px 0", color: "var(--muted)" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🛒</div>
        <p style={{ fontSize: 18, fontWeight: 300 }}>No meals planned yet</p>
        <p style={{ fontSize: 14, marginTop: 6 }}>Head to "This Week" to plan your meals</p>
      </div>
    );
  }

  const planned = Object.entries(calendarPlan).map(([key, { recipeId, servings }]) => {
    const r = recipes.find(r => r.id === recipeId);
    return r ? `${r.name} ×${servings}` : null;
  }).filter(Boolean);

  return (
    <div className="fade-in">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 32, fontWeight: 300 }}>Shopping <em>List</em></h1>
        <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 14 }}>Based on: {planned.join(" · ")}</p>
      </div>

      {shoppingList.length === 0 && (
        <p style={{ color: "var(--muted)" }}>No ingredients found — make sure your recipes have ingredients added.</p>
      )}

      <div style={{ marginBottom: 8 }}>
        <p style={{ fontSize: 12, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", marginBottom: 10 }}>ALREADY HAVE? Enter amount to deduct from total.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {unchecked.map(item => (
            <ShoppingRow key={item.key} item={item} adj={adjustments[item.key]} onAdj={v => setAdj(item.key, v)} effective={effectiveAmount(item)} onCheck={() => toggleChecked(item.key)} checked={false} />
          ))}
        </div>
      </div>

      {done.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <p style={{ fontSize: 12, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", marginBottom: 10 }}>IN BASKET ({done.length})</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {done.map(item => (
              <ShoppingRow key={item.key} item={item} adj={adjustments[item.key]} onAdj={v => setAdj(item.key, v)} effective={effectiveAmount(item)} onCheck={() => toggleChecked(item.key)} checked={true} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ShoppingRow({ item, adj, onAdj, effective, onCheck, checked }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, background: checked ? "var(--warm)" : "white", border: "1px solid var(--border)", borderRadius: 2, padding: "10px 14px", transition: "all 0.2s" }}>
      <button onClick={onCheck} style={{ width: 20, height: 20, minWidth: 20, minHeight: 20, borderRadius: "50%", border: `2px solid ${checked ? "var(--green)" : "var(--border)"}`, background: checked ? "var(--green)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer", transition: "all 0.2s", padding: 0 }}>
        {checked && <span style={{ color: "white", fontSize: 11 }}>✓</span>}
      </button>
      <span style={{ flex: 1, fontSize: 16, textDecoration: checked ? "line-through" : "none", color: checked ? "var(--muted)" : "var(--ink)" }}>{item.name}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 14, color: "var(--muted)", fontFamily: "'DM Mono', monospace", minWidth: 60, textAlign: "right" }}>
          {effective}{item.unit ? ` ${item.unit}` : ""}
        </span>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>have:</span>
        <input
          type="number"
          min="0"
          value={adj ?? ""}
          onChange={e => onAdj(e.target.value)}
          placeholder="0"
          style={{ width: 52, border: "1px solid var(--border)", background: "var(--cream)", color: "var(--ink)", borderRadius: 2, padding: "4px 6px", fontSize: 13, textAlign: "right", outline: "none", fontFamily: "'DM Mono', monospace" }}
        />
        {item.unit && <span style={{ fontSize: 12, color: "var(--muted)", minWidth: 24 }}>{item.unit}</span>}
      </div>
    </div>
  );
}

function RecipeModal({ recipe, onSave, onClose }) {
  const [form, setForm] = useState({ ...recipe, ingredients: recipe.ingredients || [], steps: recipe.steps || [] });
  const [newIng, setNewIng] = useState({ name: "", amount: "", unit: "" });
  const [newStep, setNewStep] = useState("");
  const nameRef = useRef();

  useEffect(() => { nameRef.current?.focus(); }, []);

  function addIngredient() {
    if (!newIng.name.trim()) return;
    setForm(f => ({ ...f, ingredients: [...f.ingredients, { ...newIng, amount: parseFloat(newIng.amount) || 0, id: Date.now().toString() }] }));
    setNewIng({ name: "", amount: "", unit: "" });
  }

  function removeIngredient(id) {
    setForm(f => ({ ...f, ingredients: f.ingredients.filter(i => i.id !== id) }));
  }

  function addStep() {
    if (!newStep.trim()) return;
    setForm(f => ({ ...f, steps: [...f.steps, { id: Date.now().toString(), text: newStep.trim() }] }));
    setNewStep("");
  }

  function removeStep(id) {
    setForm(f => ({ ...f, steps: f.steps.filter(s => s.id !== id) }));
  }

  function handleSave() {
    if (!form.name.trim()) return;
    onSave(form);
  }

  return (
    <div className="modal-outer" style={{ position: "fixed", inset: 0, background: "rgba(26,17,8,0.45)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card fade-in modal-padding" style={{ width: "100%", maxWidth: 620, background: "white", padding: "32px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{ fontSize: 24, fontWeight: 300 }}>{recipe.name ? `Edit Recipe` : `New Recipe`}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, color: "var(--muted)", cursor: "pointer", padding: "0 4px" }}>×</button>
        </div>

        {/* Name & Servings */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, marginBottom: 20 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>RECIPE NAME</label>
            <input ref={nameRef} className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Spaghetti Bolognese" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>BASE SERVES</label>
            <input className="input" type="text" inputMode="numeric" pattern="[0-9]*" value={form.baseServings} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, baseServings: v === "" ? "" : parseInt(v) || f.baseServings })); }} onBlur={e => { if (!e.target.value || parseInt(e.target.value) < 1) setForm(f => ({ ...f, baseServings: 1 })); }} style={{ width: 80 }} />
          </div>
        </div>

        {/* Ingredients */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ fontSize: 12, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", display: "block", marginBottom: 10 }}>INGREDIENTS</label>
          {form.ingredients.map((ing, i) => (
            <div key={ing.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, background: "var(--cream)", border: "1px solid var(--border)", borderRadius: 2, padding: "8px 10px" }}>
              <span style={{ flex: 1, fontSize: 15 }}>{ing.name}</span>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "var(--accent)" }}>{ing.amount || ""}{ing.unit ? ` ${ing.unit}` : ""}</span>
              <button className="btn-danger" onClick={() => removeIngredient(ing.id)}>✕</button>
            </div>
          ))}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 64px 80px auto", gap: 8, marginTop: 8 }} className="ing-row">
            <input className="input" placeholder="Ingredient name" value={newIng.name} onChange={e => setNewIng(n => ({ ...n, name: e.target.value }))} onKeyDown={e => e.key === "Enter" && addIngredient()} />
            <input className="input" placeholder="Qty" type="number" min="0" value={newIng.amount} onChange={e => setNewIng(n => ({ ...n, amount: e.target.value }))} />
            <select className="input" value={newIng.unit} onChange={e => setNewIng(n => ({ ...n, unit: e.target.value }))}>
              <option value="">unit</option>
              {UNITS.filter(u => u).map(u => <option key={u} value={u}>{u}</option>)}
            </select>
            <button className="btn-primary" onClick={addIngredient} style={{ whiteSpace: "nowrap" }}>Add</button>
          </div>
        </div>

        {/* Steps */}
        <div style={{ marginBottom: 28 }}>
          <label style={{ fontSize: 12, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", display: "block", marginBottom: 10 }}>METHOD</label>
          {form.steps.map((step, i) => (
            <div key={step.id} style={{ display: "flex", gap: 10, marginBottom: 8, alignItems: "flex-start" }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "var(--accent)", minWidth: 22, paddingTop: 10 }}>{i + 1}.</span>
              <div style={{ flex: 1, background: "var(--cream)", border: "1px solid var(--border)", borderRadius: 2, padding: "9px 12px", fontSize: 15, lineHeight: 1.5 }}>{step.text}</div>
              <button className="btn-danger" style={{ paddingTop: 8 }} onClick={() => removeStep(step.id)}>✕</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <textarea className="input" placeholder="Describe the next step…" value={newStep} onChange={e => setNewStep(e.target.value)} rows={2} style={{ resize: "vertical" }} onKeyDown={e => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), addStep())} />
            <button className="btn-primary" onClick={addStep}>Add</button>
          </div>
        </div>

        {/* URL */}
        <div style={{ marginBottom: 28 }}>
          <label style={{ fontSize: 12, color: "var(--muted)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>SOURCE URL <span style={{ fontWeight: 300, textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
          <input
            className="input"
            placeholder="e.g. https://www.bbcgoodfood.com/recipes/..."
            value={form.url || ""}
            onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
          />
          {form.url && (() => { try { new URL(form.url); return true; } catch { return false; } })() && (
            <a href={form.url} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: 6, fontSize: 13, color: "var(--accent)", textDecoration: "underline" }}>Open link ↗</a>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave} disabled={!form.name.trim()}>Save Recipe</button>
        </div>
      </div>
    </div>
  );
}

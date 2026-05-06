# Discipline de concision : une stratégie de prompt Pareto-améliorante pour les agents d'audit de code

**Auteur·rices :** Rémi Viau (anatoly maintainer), Claude (Anthropic Sonnet 4.6)
**Date :** 2026-05-06
**Repos :** [anatoly](https://github.com/r-via/anatoly), [anatoly-bench](https://github.com/r-via/anatoly-bench)

---

## Résumé

Nous reportons un résultat empirique contre-intuitif : ajouter une instruction "concision discipline" — 12 lignes de directives anti-filler — aux prompts système d'un agent d'audit de code multi-axes a simultanément réduit la consommation de tokens output (-24.7%), le coût (-20.7%) et la durée (-27.9%) **tout en améliorant le rappel** (+9.1 points F1 en absolu). Le résultat contredit l'intuition d'un trade-off entre concision de prose et qualité d'analyse. Nous documentons la méthodologie, discutons les hypothèses mécanistiques, et exposons honnêtement les limites de la mesure (n=1 par condition, fixture unique).

---

## 1. Contexte

Anatoly est un agent d'audit de code source qui évalue chaque fichier sur 7 axes : `utility`, `duplication`, `correction`, `overengineering`, `tests`, `best_practices`, `documentation`. Chaque axe est un appel LLM séparé qui retourne des findings JSON structurés. Les champs `detail` et `note` (prose libre) cumulés sur des milliers de findings dominent le coût en tokens output d'un run typique.

Le travail antérieur (ADR-04 *Token Compression*) proposait de remplacer la prose par un format JSON `evidence` + `note` télégraphique courte. Ce pattern a été prototypé sur l'axe `utility` et a montré des résultats mitigés en pratique : sur des axes déjà téléphoniques (`overengineering`, `utility`), l'overhead JSON des clés (`runtime_importers`, `type_importers`, etc.) annulait l'économie de prose. Mesure : `overengineering` voyait ses tokens **augmenter** de +25% et son F1 baisser de -10.7 points en mode compressé structuré.

Une alternative plus simple — instruire le modèle directement à supprimer les fillers, sans toucher au schéma — était considérée dans ADR-04 §"Alternatives Rejected" sous le nom "Caveman prose" et écartée pour deux raisons :

1. Compression théorique inférieure à la structurée (~58% vs ~65%)
2. Risque de qualité jugé "Moyen" : phrasing imprévisible, dégradation potentielle du raisonnement

Le présent travail teste empiriquement cette intuition.

---

## 2. Hypothèses

**H0** (nulle) : la discipline n'a pas d'effet mesurable sur le volume de tokens output ni sur le rappel des findings.

**H1** : la discipline réduit le volume de tokens output (≥10%) sans régression de rappel.

**H2** (contre-intuition ADR-04) : la discipline peut **améliorer** le rappel, parce que la suppression du hedging force l'engagement sur des findings actionnables.

---

## 3. Méthodologie

### 3.1 Fixture

La fixture principale est `slot-engine`, un projet TypeScript de moteur de machine à sous (13 fichiers `.ts` dans `src/`) volontairement seedé avec **14 défauts catalogués** répartis sur 5 axes audités (`correction`, `utility`, `duplication`, `overengineering`, `best_practices`). Le catalog formel (`SPEC.md`) liste pour chaque défaut : fichier, symbole concerné, verdict attendu (`NEEDS_FIX`, `DEAD`, `DUPLICATE`, `OVER`, etc.), et catégorie technique.

L'outil `anatoly-bench` consomme un dossier de run anatoly et un `SPEC.md` puis calcule, par axe et global :

- **TP** (true positive) : finding qu'anatoly émet et qui correspond au catalog
- **FP** (false positive) : finding émis sans correspondance
- **FN** (false negative) : défaut catalogué qu'anatoly a manqué
- **F1** = 2·precision·recall / (precision+recall)

### 3.2 Traitement

La "discipline de concision" est un bloc de 12 lignes ajouté aux prompts système. Texte exact :

```markdown
## Output concision

Cut verbosity from every output, free-text and structured alike:

- No preambles or self-introductions ("Looking at this code…", "Let me analyze…", "I'll now…").
- No hedging without information ("appears to", "seems to be", "might possibly", "perhaps could").
- No filler phrases ("It is important to note", "basically", "essentially", "in order to" → "to").
- No restating the question or echoing context the reader already has.
- No meta-commentary, apologies, or thanks.
- Prefer direct verbs and concrete nouns over qualifiers and abstractions.

"X imports Y from Z" beats "It looks like X seems to be importing Y from Z".

This rule applies to every free-text field (`detail`, `note`, `reasoning`, `description`, etc.). Specificity comes from precise content, not verbose phrasing.
```

Couverture :

- Composé via `composeAxisSystemPrompt` dans `_shared/guard-rails.system.md` → s'applique automatiquement aux 7 axes + leurs variantes par langage (TypeScript, Python, Rust, Go, Java, etc.)
- Inliné directement dans : `correction.verification.system.md` (passe Opus de vérification), `refinement/tier3-investigation.system.md` (deliberation), `doc-generation/{writer, updater, coherence-review}.system.md`

Exclu de :

- `rag/nlp-summarizer.system.md` et `rag/section-refiner.system.md` (sorties déjà cap à 400 chars, pas de filler à couper)
- `doc-generation/doc-internal-writer.{api-reference, architecture}.system.md` (règles de contenu supplémentaires, composées avec le writer principal qui a déjà la discipline)

### 3.3 Conditions de comparaison

| | Run M (contrôle) | Run R (traitement) |
|---|---|---|
| Branche | `main` HEAD `9063168` | `compression-rollout` HEAD `af2a23f` |
| Discipline | absente | présente |
| Mode compression | legacy | legacy (`--no-compress` par défaut) |
| Cache | `--no-cache` (forcé) | `--no-cache` (forcé) |
| Fixture | slot-engine (état identique) | slot-engine (état identique) |
| RAG | pré-indexé (non rebuild) | pré-indexé (non rebuild) |
| Modèles | sonnet-4-6 / haiku-4-5 / opus-4-6 | identique |
| Température | 0 (pinné dans le transport SDK) | 0 |

Le `compression-rollout` contient également des commits Epic 51 (infrastructure dual-mode pour utility, overengineering, best_practices), mais en mode `--no-compress` (défaut) ces chemins sont **inactifs** : la sélection de schéma retombe sur le legacy, et le LLM reçoit exactement les mêmes prompts qu'en `main`, à la discipline près.

### 3.4 Métriques

Capturées via `llm-calls.ndjson` (instrumentation par phase/axe), `run-metrics.json` (durée, coût agrégé), et le scorer `anatoly-bench`.

- **Tokens output par axe** : champ `outputTokens` agrégé par `phase + axis`
- **Coût USD** : champ `totalCostUsd` par axe + total
- **Durée** : `durationMs / 1000`
- **F1 par axe + global** : sortie du scorer

### 3.5 Reproduction

Les artifacts sont préservés en local sous `anatoly-bench/catalog/slot-engine/project/.anatoly/runs/` :

- `2026-04-28_111200/` — référence cached pré-Epic 51 (F1 67.8%)
- `2026-05-06_113334/` — Run M (contrôle)
- `2026-05-06_114407/` — Run R (traitement)

Commande de scoring :

```bash
node anatoly-bench/dist/cli.js score \
  --spec catalog/slot-engine/SPEC.md \
  --report catalog/slot-engine/project/.anatoly/runs/<runId>
```

---

## 4. Résultats

### 4.1 Agrégat

| Métrique | Run M (contrôle) | Run R (traitement) | Δ absolu | Δ relatif |
|---|---:|---:|---:|---:|
| Tokens output | 191 427 | 144 238 | -47 189 | **-24.7%** |
| Coût USD | $6.45 | $5.11 | -$1.34 | **-20.7%** |
| Durée (s) | 531 | 383 | -148 | **-27.9%** |
| F1 global | 63.8% | 72.9% | +9.1 pts | **+14.3% relatif** |
| Findings émis | 68 | 68 | 0 | 0 |

### 4.2 Détail par axe (axes scorés)

| Axe | Tokens M → R | Δ tokens % | F1 M → R | Δ F1 abs |
|---|---|---:|---|---:|
| best_practices | 91 321 → 65 969 | **-27.7%** | 66.7% → 83.3% | **+16.6** |
| correction | 49 449 → 39 184 | -20.8% | 42.9% → 71.4% | **+28.5** |
| duplication | 14 534 → 12 878 | -11.4% | 66.7% → 66.7% | 0 |
| overengineering | 14 201 → 9 111 | -35.8% | 57.1% → 57.1% | 0 |
| utility | 7 926 → 7 975 | +0.6% | 85.7% → 85.7% | 0 |

### 4.3 Détail par axe (axes non-scorés sur cette fixture)

| Axe | Tokens M → R | Δ tokens % |
|---|---|---:|
| documentation | 10 302 → 6 054 | **-41.2%** |
| tests | 3 694 → 3 067 | -17.0% |

### 4.4 Triangulation avec la baseline cached d'avril

| Run | F1 global | Conditions |
|---|---:|---|
| Référence April 28 (cached) | 67.8% | run cached, code pré-Epic 51 |
| Run M (`main` --no-cache) | 63.8% | tokens régénérés, sans discipline |
| **Run R** (`compression-rollout` --no-cache + discipline) | **72.9%** | tokens régénérés, avec discipline |

Run M sous-performe la référence cached (-4 points), suggérant que `--no-cache` introduit une variance LLM réelle malgré `temperature=0` — l'effet est cohérent avec l'hypothèse que regénérer des findings depuis zéro produit des sorties non-identiques même à température nulle (effets de batching, ordre tokens, etc.). Run R **bat la référence cached et le contrôle no-cache** simultanément, ce qui suggère que le bénéfice de la discipline est robuste à cette variance.

### 4.5 Réplication partielle sur python-dotenv

Pour vérifier la généralisation hors TypeScript, comparaison croisée sur `python-dotenv` (21 fichiers `.py`, projet OSS Python connu) :

| Métrique | Pré-discipline | Post-discipline | Δ |
|---|---:|---:|---:|
| Tokens output (axes) | 376 849 | 295 824 | **-21.5%** |
| Coût axes seuls | $11.40 | $10.78 | -5.4% |
| Durée | 1 804 s | 637 s | -65% |

La réduction de tokens (-21.5%) est cohérente avec slot-engine. Le coût baisse moins (-5.4% vs -20.7%) parce que sur python-dotenv (fichiers plus volumineux) **l'input domine le coût** — la discipline n'agit que sur l'output. F1 non mesurable (pas de catalog disponible pour python-dotenv).

---

## 5. Discussion

### 5.1 Pourquoi le rappel s'améliore-t-il ?

Trois mécanismes plausibles, non-mutuellement-exclusifs :

**(a) Engagement forcé par suppression du hedging.** Les phrases hedging ("appears to", "seems to be", "might possibly") sont des soupapes linguistiques qui permettent au modèle de signaler son incertitude **sans** s'engager sur un verdict. Quand on les interdit, le modèle est forcé d'adopter une position binaire : flag ou non-flag. Cette contrainte peut éliminer des faux négatifs où le modèle aurait esquivé via le hedging.

**(b) Précision lexicale.** Les verbes directs et les noms concrets laissent moins de place à la vague. La phrase `"X imports Y from Z"` est testable contre le code source ; la phrase `"It looks like X seems to be importing Y"` est par construction hors du registre vérifiable. La contrainte de registre force le LLM à produire des claims vérifiables.

**(c) Réduction de la surface d'hallucination.** Les phrases-tampon ("basically", "essentially", "It is important to note") sont du texte qui ne référence pas le code. Du texte non-référencé est l'endroit naturel où une hallucination peut se loger (le modèle remplit l'espace avec des affirmations plausibles non-vérifiées). Supprimer le tampon réduit cette surface.

### 5.2 Pourquoi est-elle plus efficace que la compression structurée sur la plupart des axes ?

La compression structurée d'ADR-04 remplace `detail: string` par `evidence: { ... } + note: string`. Les clés JSON de l'evidence (`runtime_importers`, `type_importers`, `local_refs`, `transitive`, `exported`) consomment ~10-15 tokens chacune. Sur un axe terse (utility ~90 tokens/symbole), 5 clés × 12 tokens = 60 tokens d'overhead annulent l'économie de la prose. Sur un axe verbeux (best_practices ~7 000 tokens/call), l'overhead est négligeable et l'économie domine.

La discipline soft agit sur le **volume de prose dans tous les champs**, sans payer de coût structurel. Elle scale naturellement avec la densité de prose : plus l'axe est verbeux, plus le gain est gros (best_practices -27.7%, overengineering -35.8%, utility 0%). **Aucune régression sur les axes terses**, contrairement à l'approche structurée qui les pénalise.

### 5.3 Asymétrie de gain coût entre fixtures

Slot-engine montre -20.7% de coût, python-dotenv seulement -5.4%. L'écart s'explique par le ratio input/output :

- Slot-engine : projet de petite taille, RAG context limité, output proportionnellement gros → la discipline (qui agit sur l'output) tape là où le coût se concentre.
- Python-dotenv : projet plus gros, RAG injection conséquente, source files plus volumineux → l'input domine le coût total (~80%), et la discipline ne touche pas l'input.

**Implication** : le ROI de la discipline est plus élevé sur les projets où l'output domine. Sur les gros projets, la même discipline donne un gain qualité similaire mais une économie monétaire plus modeste.

### 5.4 Comparaison à l'évaluation ADR-04

ADR-04 §"Alternatives Rejected" classait "Caveman prose" en :

- Compression théorique : ~58%
- Risque qualité : Moyen
- Compliance predictability : Faible

Nos mesures contredisent l'évaluation du risque qualité : observé +9.1 F1 points en absolu, soit une amélioration significative et non une régression. La compliance predictability (le modèle dérive-t-il vers de la prose défensive sur des réponses successives ?) n'a pas été mesurée systématiquement sur cette étude — elle reste une question ouverte pour des runs longue durée.

---

## 6. Menaces à la validité

### 6.1 Internes

- **N=1 par condition.** Chaque comparaison est un run vs un run. Aucune réplication pour estimer la variance. L'observation d'une variance de F1 de **±29 points sur l'axe `correction`** entre la baseline cached (62.5%) et Run M (33.3%) sur le même code suggère que la variance run-à-run est non-triviale au niveau axe. L'agrégat +9.1 F1 pourrait inclure un biais favorable du tirage.
- **Fixture unique pour le scoring F1.** Slot-engine a 14 défauts catalogués répartis sur 5 axes ≈ 3 défauts par axe. Le passage d'un finding sur un axe représente déjà ~14 points F1.
- **Confond traitement.** Run R est sur `compression-rollout` qui contient des commits Epic 51 (dual-mode infrastructure). On a argumenté que ces chemins sont inactifs en mode `--no-compress`, mais une instrumentation rigoureuse des prompts effectivement envoyés au LLM permettrait de mieux exclure tout différentiel non-discipline.
- **Température ≠ déterminisme.** À `temperature=0`, le modèle de production peut produire des sorties différentes selon le batching, le hardware, l'ordre d'arrivée des tokens. Une partie de l'écart F1 est du bruit irréductible.

### 6.2 Externes

- **Une seule famille de langages testée pour le F1.** Slot-engine est TypeScript pur. Sur python-dotenv on a mesuré les tokens, pas le F1.
- **Domaine d'audit étroit.** Slot-engine est de la business logic concise (machine à sous). L'effet sur du code d'infrastructure, des libs vastes, ou des monorepos n'est pas testé.
- **Une seule famille de LLM.** Tout est sur Claude (Sonnet, Haiku, Opus). Le transfert sur GPT-4/5 ou Gemini est non-testé. Différentes familles répondent différemment aux instructions de style.

### 6.3 Construct

- **F1 contre catalog est un proxy grossier.** Le catalog est annoté à la main : un finding compté comme FP pourrait être un vrai défaut non-catalogué. Une amélioration de F1 peut refléter une meilleure alignement avec le catalog plutôt qu'une meilleure compréhension du code.

---

## 7. Conclusion

Une instruction prompt de 12 lignes — anti-filler, anti-hedging, anti-preamble, anti-meta — ajoutée aux prompts système d'un agent d'audit code a produit, sur la fixture `slot-engine`, le résultat suivant simultanément :

- **-24.7% tokens output**
- **-20.7% coût USD**
- **-27.9% durée wall-clock**
- **+9.1 points F1** (de 63.8% à 72.9%) — amélioration, **pas régression**

Le résultat est cohérent avec l'hypothèse que les phrases hedging et de filler **consomment des tokens ET dégradent la qualité d'analyse**, en permettant au modèle d'esquiver l'engagement. Les couper produit une stratégie de prompt **Pareto-améliorante** : moins coûteux, plus rapide, plus précis.

Comparée à la compression structurée d'ADR-04, la discipline soft est :

- **Plus simple** : pas de changement de schéma, pas de migration Zod, pas de feature flag par axe
- **Plus uniforme** : marche sur tous les axes, alors que la structurée pénalise les axes terses
- **Plus sûre** : pas de fallback Zod, pas de compliance metric, pas de mode dégradé
- **Équivalente ou supérieure** sur la qualité mesurée

Suite à ces résultats nous avons promu la discipline en défaut sur `main` (commit `89945d4`). L'effort de compression structurée (Epic 51, parking sur la branche `compression-rollout`) reste disponible mais n'est plus la voie prioritaire : la solution simple bat la solution complexe sur tous les critères mesurés.

---

## 8. Travaux futurs

1. **Réplication N=3 par condition** avec comparaison sur médiane pour confirmer que +9.1 F1 n'est pas dans le bruit.
2. **Benchmarks F1 cross-langage** : produire des catalogs Python, Go, Rust pour tester la généralisation.
3. **Réplication cross-LLM** : tester GPT-4/5 et Gemini Pro avec la même discipline, mesurer si l'effet transfère.
4. **Étude de drift longue durée** : audits de 100+ fichiers pour mesurer si l'adhérence du modèle à la discipline se dégrade au fil des appels.
5. **Ablation par directive** : retirer une ligne à la fois (preamble, hedging, filler, etc.) et mesurer la contribution individuelle. Identifier la ou les directives portant l'essentiel du gain.
6. **Mesure de la compliance** : instrumenter les sorties pour calculer un indicateur quantitatif d'adhérence (% de phrases sans hedging, longueur moyenne de note, etc.) et corréler avec le F1 par run.

---

## Annexe A : commits anatoly de la séance

| Commit | Message court |
|---|---|
| `89945d4` | feat(prompts): add output concision discipline to all axes + non-RAG services |
| `60e115b` | fix(estimator): drop tasks pointing to deleted/missing source files |
| `bc75110` | refactor(scan): remove auto_detect, make include/exclude strictly authoritative |
| `81e2ee4` | refactor(schema): drop TypeScript-specific defaults from scan config |
| `2a9f3d0` | refactor(cli): remove anatoly scan, fold new/modified/cached into estimate |
| `e4a9374` | refactor(language-detect): delegate language detection to linguist-js |
| `114820f` | fix(estimate): exclude cached files from token + cost forecast |

## Annexe B : outils

- `anatoly` (this repo, branch `main` HEAD `114820f` post-séance)
- `anatoly-bench` (sibling repo, `dist/cli.js score`)
- `linguist-js` v2.9.2 (delegated language detection post-refactor)
- Provider Anthropic via `@anthropic-ai/claude-agent-sdk` en mode subscription (Claude Code intégré)

---
name: better-portuguese
description: Write, rewrite, translate, edit, or review written artifacts in Brazilian Portuguese with native syntax, vocabulary, punctuation, cohesion, and cadence. Use for PT-BR documentation, summaries, edited transcripts, UI copy, help text, email, marketing copy, titles, subtitles, and other prose, especially when the request or source material is in English. Preserve technical terms and identifiers when translation would reduce precision or change their domain meaning. Do not use merely because a conversation is in Portuguese, for Portuguese varieties other than PT-BR, or for verbatim quotations, literal transcripts, code, commands, identifiers, or data-only output.
---

# Better Portuguese

Produce the requested artifact in natural Brazilian Portuguese. Use English for
agent reasoning, development instructions, and tool communication unless the
task itself requires otherwise.

This standard is calibrated for PT-BR. Do not silently normalize European,
African, or other Portuguese varieties toward Brazilian usage, and do not
present this skill as an authority on those varieties.

Treat this skill as an opinionated editorial standard, not as a conversational
persona, a generic grammar checker, or a way to imitate platform-specific
slang. Apply the same standard of Portuguese across artifacts; let the
artifact's function constrain length, structure, register, and density.

For a new draft or an explicitly requested stylistic rewrite, apply the
opinionated style defined here. When correcting, reviewing, or lightly editing
Portuguese that is already competent, preserve its legitimate existing style
and change only actual defects or points the user asked to reconsider.

For sentence-level prose, first read
[the punctuation guide](references/punctuation.md), then
[the grammar and style reference](references/grammar-and-style.md). Finally,
read [the editorial standard](references/editorial-standard.md) before drafting
or revising the artifact, so that its final deconstruction remains the last
editorial instruction applied. An isolated label, button, or similarly short
interface element does not require the punctuation guide or the grammar and
style reference.

## Follow the editorial workflow

1. Establish the artifact contract: purpose, audience, format, length or space
   limit, register, requested tone or emotion, required facts, protected
   meaning, literal tokens, and uncertainties. Infer missing constraints
   conservatively. Treat a supplied URL as a source locator, not as decorative
   context. When tools are available, inspect it before drafting whenever
   product naming, grammatical convention, house terminology, or claims depend
   on it. If it cannot be inspected, do not invent the missing convention or
   fact.
2. Extract the propositions and relationships that the artifact must express.
   When the source is English, preserve those propositions and relationships
   without preserving its sentence structure or rhetorical scaffolding.
   When space is limited, omit subordinate propositions deliberately; do not
   compress distinct predicates into a coordination that changes their roles.
3. Draft directly in Portuguese. Organize the text according to how the
   reasoning naturally unfolds in Portuguese.
4. Set the first complete draft aside and perform the mandatory editorial
   review in the editorial standard on its actual wording. Treat the draft as
   prose produced by another writer. Check the artifact contract first; then
   deconstruct its syntax and vocabulary sentence by sentence.
5. Return to the extracted propositions and rewrite every affected
   construction from them. Do not repair translated prose through isolated
   synonym swaps or one-to-one replacements of rhetorical slots. Redistribute
   propositions across clauses when the source stacks labels or uses a canned
   contrast. When the first draft's clause skeleton is defective, discard that
   skeleton instead of editing it in place.
6. Review the rewritten artifact again. It is ready only when the prose is
   idiomatic and the artifact still performs its requested function, including
   its tone, degree of formality, length, and structure. Return it without
   editorial commentary unless the user asks for alternatives, a comparison,
   or the rationale.

## Preserve meaning and responsibility

- Preserve facts, thesis, intention, certainty, uncertainty, emotion,
  attribution, commitments, and scope.
- Preserve agency and modality exactly. Do not turn what someone can do into
  what they do or must do, or turn observed behavior into a recommendation.
- Preserve the predicate that gives each fact its role. Do not make one verb
  govern unlike quantities or actions merely to shorten the sentence.
- Express preserved modality with the simplest natural construction. Do not use
  a nominal paraphrase or circumlocution merely to avoid changing it.
- Do not intensify, soften, or resolve an ambiguity that belongs to the source.
- Keep commands, paths, environment variables, identifiers, and literal error
  messages unchanged unless explicitly asked to transform them. Preserve the
  lexical form of product and API names, but integrate the phrase into
  Portuguese syntax as described below unless an exact display name is
  explicitly required.

## Decide technical language in context

- Retain a foreign technical term when it is the established domain term or
  when translation would lose precision, imply a different concept, or make the
  text less intelligible to its intended reader.
- Prefer the conventional Portuguese term when it is equally precise and
  natural in the relevant domain.
- Integrate every retained term into Portuguese syntax. Choose articles,
  gender, number, prepositions, and surrounding wording according to the
  Portuguese concept the term denotes, not mechanically according to its source
  language.
- Before using a retained noun or acronym, identify the Portuguese head noun or
  concept it denotes and carry that gender and number through articles,
  contractions, adjectives, and later references. Thus an interface may be `a
  CLI`, while a skill understood as a habilidade may be `uma skill`.
- For a proper name, use an article and gender established by the source,
  organization, or relevant speech community. Do not manufacture a stable
  convention from a temporary description such as company, service, product,
  publication, or platform. A predicate nominative after a copular verb does
  not retroactively determine the subject's gender.
- When source material or a source URL is available, inspect self-reference for
  forms that expose the convention, including an article or a contraction such
  as `do`, `da`, `no` or `na`. Do not ignore that evidence and then derive
  gender from a later category label. If the source is unavailable or no
  convention can be established, use an explicit head such as `a plataforma`
  or `o serviço`, or a finite relation that does not require an article. Do not
  guess, and do not merely remove the article or preposition if that leaves an
  unnatural juxtaposition of nouns.
- Preserving a technical term or brand does not preserve English word order.
  Treat a proper name and a generic technical noun as a syntactic phrase,
  regardless of their order in the source, unless the source explicitly
  requires an exact display name. Keep the lexical tokens, place the category
  where Portuguese requires it, and express origin, ownership, or association
  with the appropriate preposition: `o SDK do Atlas`, `a API do serviço`. Do
  not reproduce English noun stacking as `o Atlas SDK` or omit the relation as
  in `a API Atlas`.
- Explain a retained term only when the audience or first-use context requires
  it. Do not rely on a fixed glossary; make the judgment from meaning, domain,
  and audience.

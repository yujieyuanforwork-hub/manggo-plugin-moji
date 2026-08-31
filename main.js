const API_ENDPOINT = "https://api.mojidict.com/parse/functions";
const WEB_DETAIL_URL = "https://www.mojidict.com/details/";
const WEB_SEARCH_URL = "https://www.mojidict.com/searchText/";

const SEARCH_TYPE_WORD = 102;
const SEARCH_TYPE_EXAMPLE = 103;
const SEARCH_TYPE_GRAMMAR = 106;

const MAX_GRAMMAR_MEANINGS = 5;
const RETRY_DELAY_MS = 600;
// 平假名、片假名、汉字与半角片假名。
const JAPANESE_PATTERN = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

// MOJi Web 客户端的公开参数，用户无需配置。
const CLIENT_PAYLOAD = {
  _ClientVersion: "js3.4.1",
  _ApplicationId: "E62VyFVLMiW7kvbtVq3p",
  g_os: "PCWeb",
  g_ver: "v4.8.8.20240829",
  _InstallationId: "1b2822a6-ede5-43e3-addb-00003642f992",
};

function stringValue(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function booleanValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function integerValue(value, fallback, min, max) {
  const number = Number(value);
  const resolved = Number.isFinite(number) ? Math.trunc(number) : fallback;
  return Math.min(max, Math.max(min, resolved));
}

function hasJapanese(text) {
  return JAPANESE_PATTERN.test(text);
}

function truncated(text, limit = 24) {
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : text;
}

function sortedByIndex(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === "object")
    .map((item, position) => ({ item, position }))
    .sort((a, b) => {
      const left = Number(a.item.index);
      const right = Number(b.item.index);
      const leftIndex = Number.isFinite(left) ? left : Number.MAX_SAFE_INTEGER;
      const rightIndex = Number.isFinite(right) ? right : Number.MAX_SAFE_INTEGER;
      return leftIndex === rightIndex ? a.position - b.position : leftIndex - rightIndex;
    })
    .map((entry) => entry.item);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// MOJi 偶发返回 429/5xx，重试一次即可，避免把瞬时限流暴露给用户。
async function fetchWithRetry(fetchImpl, url, init) {
  let response = await fetchImpl(url, init);
  if (response.status === 429 || response.status >= 500) {
    await delay(RETRY_DELAY_MS);
    response = await fetchImpl(url, init);
  }
  return response;
}

async function callMojiFunction(name, params, options) {
  const fetchImpl = options?.utils?.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("当前运行环境没有提供 utils.fetch。");
  }

  const response = await fetchWithRetry(fetchImpl, `${API_ENDPOINT}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ ...CLIENT_PAYLOAD, ...params }),
  });

  if (!response.ok) {
    throw new Error(`MOJi辞書 请求失败：HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    throw new Error("MOJi辞書 返回了无法解析的响应。");
  }

  const result = payload?.result;
  if (!result || typeof result !== "object") {
    throw new Error(`MOJi辞書 返回了意外的响应结构：${JSON.stringify(payload).slice(0, 200)}`);
  }

  return result;
}

function normalizeSearchSection(section) {
  const items = Array.isArray(section?.searchResult) ? section.searchResult : [];
  return items
    .map((item) => ({
      id: stringValue(item?.targetId),
      title: stringValue(item?.title),
      excerpt: stringValue(item?.excerpt),
    }))
    .filter((item) => item.title || item.excerpt);
}

async function searchAll(text, options) {
  const result = await callMojiFunction(
    "union-api",
    {
      functions: [
        {
          name: "search-all",
          params: {
            text,
            types: [SEARCH_TYPE_WORD, SEARCH_TYPE_GRAMMAR, SEARCH_TYPE_EXAMPLE],
          },
        },
      ],
    },
    options,
  );

  const searchResult = result?.results?.["search-all"]?.result;
  if (!searchResult || typeof searchResult !== "object") {
    throw new Error(`MOJi辞書 搜索失败：${JSON.stringify(result).slice(0, 200)}`);
  }

  return {
    words: normalizeSearchSection(searchResult.word),
    grammars: normalizeSearchSection(searchResult.grammar),
    examples: normalizeSearchSection(searchResult.example),
  };
}

async function fetchWordDetail(wordId, options) {
  const result = await callMojiFunction("fetchWord_v2", { wordId, skipAccessories: false }, options);
  const word = result?.word;
  if (!word || typeof word !== "object") {
    throw new Error("MOJi辞書 没有返回词条详情。");
  }

  return {
    word,
    details: sortedByIndex(result.details),
    subdetails: sortedByIndex(result.subdetails),
    examples: sortedByIndex(result.examples),
  };
}

async function fetchPronunciationUrl(wordId, options) {
  const result = await callMojiFunction(
    "fetchTts_v2",
    { tarId: wordId, tarType: SEARCH_TYPE_WORD, voiceId: 0 },
    options,
  );
  return stringValue(result?.result?.url);
}

function titleSpell(title) {
  return stringValue(stringValue(title).split("|")[0]);
}

function titleReading(title) {
  const parts = stringValue(title).split("|");
  return parts.length > 1 ? stringValue(parts.slice(1).join("|")) : "";
}

function titleKana(title) {
  return titleReading(title).replace(/[^ぁ-ゟァ-ヿー]/g, "");
}

// 比较词形时忽略 MOJi 条目里的占位符号与空白，例如「〜ながら」对应「ながら」。
function normalizeForMatch(text) {
  return stringValue(text).replace(/[〜~～…・\s]/g, "");
}

function pickWord(words, text) {
  const query = stringValue(text);
  return words.find((word) => titleSpell(word.title) === query) || words[0] || null;
}

function findSpeakableWord(candidates, text, strictMatch) {
  const query = normalizeForMatch(text);
  const speakable = candidates.filter((candidate) => candidate.id);

  const exact = speakable.find((candidate) => {
    return (
      normalizeForMatch(titleSpell(candidate.title)) === query ||
      normalizeForMatch(titleKana(candidate.title)) === query
    );
  });
  if (exact) return exact;

  return strictMatch ? null : speakable[0] || null;
}

async function downloadAudio(url, options) {
  const fetchImpl = options?.utils?.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("当前运行环境没有提供 utils.fetch。");
  }

  const response = await fetchWithRetry(fetchImpl, url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`MOJi辞書 发音下载失败：HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("MOJi辞書 返回的发音内容为空。");
  }

  return bytes;
}

function formatPartOfSpeech(title) {
  return stringValue(title).replace(/#/g, "·");
}

function formatExamplePair(source, translation) {
  const left = stringValue(source);
  const right = stringValue(translation);
  if (left && right) return `${left} —— ${right}`;
  return left || right;
}

function detailMeanings(detail, maxExamples) {
  const partsOfSpeech = new Map(
    detail.details.map((item) => [stringValue(item.objectId), formatPartOfSpeech(item.title)]),
  );

  const examplesBySubdetail = new Map();
  for (const example of detail.examples) {
    const key = stringValue(example.subdetailsId);
    if (!key) continue;
    const formatted = formatExamplePair(example.title, example.trans);
    if (!formatted) continue;
    if (!examplesBySubdetail.has(key)) examplesBySubdetail.set(key, []);
    examplesBySubdetail.get(key).push(formatted);
  }

  const meanings = [];
  for (const subdetail of detail.subdetails) {
    const translation = stringValue(subdetail.title);
    const examples = (examplesBySubdetail.get(stringValue(subdetail.objectId)) || []).slice(0, maxExamples);
    if (!translation && examples.length === 0) continue;

    const meaning = {};
    const partOfSpeech = partsOfSpeech.get(stringValue(subdetail.detailsId));
    if (partOfSpeech) meaning.partOfSpeech = partOfSpeech;
    if (translation) meaning.translations = [translation];
    if (examples.length) meaning.examples = examples;
    meanings.push(meaning);
  }

  if (meanings.length) return meanings;

  // 词条没有分义项时，退回到词条摘要加全部例句。
  const excerpt = stringValue(detail.word.excerpt);
  const examples = detail.examples
    .map((example) => formatExamplePair(example.title, example.trans))
    .filter(Boolean)
    .slice(0, maxExamples);

  if (!excerpt && examples.length === 0) return [];

  const meaning = {};
  const partOfSpeech = formatPartOfSpeech(detail.details[0]?.title);
  if (partOfSpeech) meaning.partOfSpeech = partOfSpeech;
  if (excerpt) meaning.translations = [excerpt];
  if (examples.length) meaning.examples = examples;
  return [meaning];
}

function summaryMeanings(word) {
  const excerpt = stringValue(word?.excerpt);
  if (!excerpt) return [];

  const matched = excerpt.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  const meaning = {};
  if (matched) {
    const partOfSpeech = stringValue(matched[1]);
    const translation = stringValue(matched[2]);
    if (partOfSpeech) meaning.partOfSpeech = formatPartOfSpeech(partOfSpeech);
    if (translation) meaning.translations = [translation];
  } else {
    meaning.translations = [excerpt];
  }

  return meaning.translations?.length ? [meaning] : [];
}

function grammarMeanings(grammars, limit) {
  return grammars
    .slice(0, limit)
    .map((grammar) => {
      const label = stringValue(grammar.title);
      const explanation = stringValue(grammar.excerpt).replace(/^\[文法\]\s*/, "");
      const meaning = { partOfSpeech: "文法" };
      if (explanation) {
        meaning.translations = [explanation];
        if (label) meaning.tags = [label];
      } else if (label) {
        meaning.translations = [label];
      }
      return meaning;
    })
    .filter((meaning) => meaning.translations?.length);
}

function exampleMeaning(examples, limit) {
  const formatted = examples
    .map((example) => formatExamplePair(example.title, example.excerpt))
    .filter(Boolean)
    .slice(0, limit);
  return formatted.length ? { partOfSpeech: "例文", examples: formatted } : null;
}

function buildPronunciations(detailWord, searchWord, audioUrl) {
  const pronunciations = [];
  const kana = stringValue(detailWord?.pron);
  const accent = stringValue(detailWord?.accent);
  const reading = [kana, accent].filter(Boolean).join(" ") || titleReading(searchWord?.title);

  if (reading || audioUrl) {
    const pronunciation = { label: "かな" };
    if (reading) pronunciation.phonetic = reading;
    if (audioUrl) pronunciation.audioUrl = audioUrl;
    pronunciations.push(pronunciation);
  }

  const romaji = stringValue(detailWord?.romaji);
  if (romaji) pronunciations.push({ label: "ローマ字", phonetic: romaji });

  return pronunciations;
}

function buildTags(detailWord) {
  const raw = stringValue(detailWord?.tags);
  if (!raw) return [];
  const tags = raw
    .split(/[#、,，\s]+/)
    .map((tag) => stringValue(tag))
    .filter(Boolean);
  return [...new Set(tags)];
}

function buildProperties(primaryWord, relatedWords) {
  const properties = [{ key: "source", label: "来源", value: "MOJi辞書" }];

  if (primaryWord?.id) {
    properties.push({
      key: "detailUrl",
      label: "词条链接",
      value: `${WEB_DETAIL_URL}${primaryWord.id}`,
    });
  }

  relatedWords.forEach((word, index) => {
    const value = [stringValue(word.title), stringValue(word.excerpt)].filter(Boolean).join("  ");
    if (!value) return;
    properties.push({ key: `relatedWord${index + 1}`, label: "相关词条", value });
  });

  return properties;
}

export async function translate(text, from, to, options) {
  const query = stringValue(text);
  if (!query) {
    throw new Error("请输入要查询的内容。");
  }

  const config = options?.config || {};
  const maxExamples = integerValue(config.maxExamples, 3, 0, 20);
  const maxRelatedWords = integerValue(config.maxRelatedWords, 4, 0, 20);

  const search = await searchAll(query, options);
  const primaryWord = pickWord(search.words, query);

  let detail = null;
  if (primaryWord?.id && booleanValue(config.detailedLookup, true)) {
    try {
      detail = await fetchWordDetail(primaryWord.id, options);
    } catch (_) {
      detail = null;
    }
  }

  let audioUrl = "";
  if (primaryWord?.id && booleanValue(config.pronunciationAudio, true)) {
    try {
      audioUrl = await fetchPronunciationUrl(primaryWord.id, options);
    } catch (_) {
      audioUrl = "";
    }
  }

  const meanings = [];
  if (detail) meanings.push(...detailMeanings(detail, maxExamples));
  if (!meanings.length && primaryWord) meanings.push(...summaryMeanings(primaryWord));
  if (booleanValue(config.includeGrammar, true)) {
    meanings.push(...grammarMeanings(search.grammars, MAX_GRAMMAR_MEANINGS));
  }
  if (booleanValue(config.includeExamples, true)) {
    const meaning = exampleMeaning(search.examples, maxExamples);
    if (meaning) meanings.push(meaning);
  }

  if (!meanings.length) {
    throw new Error(`MOJi辞書 没有找到“${truncated(query)}”的释义。`);
  }

  const dictionary = {
    word: stringValue(detail?.word?.spell) || titleSpell(primaryWord?.title) || query,
    language: "ja_JP",
    meanings,
  };

  const pronunciations = buildPronunciations(detail?.word, primaryWord, audioUrl);
  if (pronunciations.length) dictionary.pronunciations = pronunciations;

  const tags = buildTags(detail?.word);
  if (tags.length) dictionary.tags = tags;

  const relatedWords = search.words
    .filter((word) => !primaryWord || word.id !== primaryWord.id)
    .slice(0, maxRelatedWords);
  dictionary.properties = buildProperties(primaryWord, relatedWords);

  if (audioUrl) dictionary.audioUrl = audioUrl;

  return { kind: "dictionary", dictionary };
}

// MOJi 只为词典收录的词条和文法条目提供录音，不支持任意文本合成。
export async function tts(text, language, options) {
  const query = stringValue(text);
  if (!query) {
    throw new Error("请输入要朗读的内容。");
  }

  const config = options?.config || {};
  const maxLength = integerValue(config.maxLength, 32, 1, 200);
  if ([...query].length > maxLength) {
    throw new Error(`MOJi辞書 只能朗读词典收录的词条，当前文本超过 ${maxLength} 个字符。`);
  }

  const search = await searchAll(query, options);
  const word = findSpeakableWord(
    [...search.words, ...search.grammars],
    query,
    booleanValue(config.strictMatch, true),
  );

  if (!word) {
    throw new Error(`MOJi辞書 没有收录“${truncated(query)}”对应的词条发音。`);
  }

  const audioUrl = await fetchPronunciationUrl(word.id, options);
  if (!audioUrl) {
    throw new Error(`MOJi辞書 没有提供“${truncated(titleSpell(word.title) || query)}”的发音音频。`);
  }

  return {
    bytes: await downloadAudio(audioUrl, options),
    format: "mp3",
  };
}

export function canOpenInMoji(selectedText, options) {
  const text = stringValue(selectedText);
  if (!text) return false;

  const config = options?.config || {};
  if ([...text].length > integerValue(config.maxLength, 32, 1, 200)) return false;
  if (booleanValue(config.japaneseOnly, false) && !hasJapanese(text)) return false;

  return true;
}

export function openInMoji(selectedText, options) {
  const text = stringValue(selectedText);
  if (!text) {
    throw new Error("选中的内容为空。");
  }

  const openWithDefaultBrowser = options?.manggo?.openWithDefaultBrowser;
  if (typeof openWithDefaultBrowser !== "function") {
    throw new Error("当前运行环境没有提供 manggo.openWithDefaultBrowser。");
  }

  openWithDefaultBrowser(`${WEB_SEARCH_URL}${encodeURIComponent(text)}`);
}

export default {
  translate,
  tts,
  canOpenInMoji,
  openInMoji,
};

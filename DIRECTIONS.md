# DIRECTIONS

## この文書の目的

この文書は、このレポジトリに将来取り組むときのための「再現可能な調査メモ」です。  
既存の解答や順位表の内容は思考過程に含めず、**レポジトリ内の観測事実**と**公開されている公式ドキュメント/性能改善資料**だけを根拠に、どこに改善余地がありそうか・どう調べるか・どう結論づけるかを整理します。

---

## 1. 先に固定する前提

まず、何を最適化すべきかを採点基準と制約から固定します。

- 採点は Lighthouse ベースで、**ページランディング 4 ページ**と**ユーザーフロー 4 本**の合算です。
  - ランディング: ホーム / 商品詳細 / 購入手続き / 404
  - ユーザーフロー: ログイン / レビュー投稿 / 注文 / 初回ユーザー購入
- ランディングでは FCP / Speed Index / LCP / TBT / CLS が効きます。
- ユーザーフローでは TBT / INP が効きます。
- レギュレーション上、**著しい機能落ちやデザイン差異は禁止**です。
- チェックリスト上、`/initialize`、`data-testid`、各 UI の挙動、404 ページや購入完了ページでの Noto Serif JP 表示などは維持が必要です。

つまり、改善の優先順位は次の通りです。

1. 初期表示のネットワーク転送量と描画ブロックを減らす  
2. ユーザーフロー中の JavaScript 実行負荷と待ち時間を減らす  
3. ただし、見た目と操作は崩さない  

---

## 2. 最初に行う再現手順

最初の観測は、最低でも次の手順で揃えます。

```bash
pnpm install --frozen-lockfile
pnpm build

du -sh dist dist/assets dist/assets/*
find public -type f -printf '%12s %p\n' | sort -nr | head -n 30
du -sh public/*
```

ローカルでレスポンスヘッダも確認します。

```bash
pnpm exec ts-node src/server
```

別ターミナルで:

```bash
asset=$(basename dist/assets/index-*.js)
curl -I http://127.0.0.1:8080/
curl -I "http://127.0.0.1:8080/assets/$asset"
```

その上で、**最新版 Chrome の Lighthouse** で以下を確認します。

- ホーム
- 商品詳細
- 購入手続き
- 404
- ログイン
- レビュー投稿
- 注文
- 初回ユーザー購入

以後の改善は、できるだけ **1 つの仮説ごとに変更して再計測**します。  
一度に全部変えると、どの変更が効いたのか分からなくなります。

---

## 3. このレポジトリで最初に観測できた事実

今回の調査時点では、次の事実を確認できました。

### ビルドと静的アセット

- `pnpm build` の出力には、**約 13.4 MB の JS バンドル**と**約 6.8 MB の CanvasKit WASM**が含まれる
- `dist` 全体は約 **119 MB**
- `public` 全体は約 **100 MB**
  - `public/images`: 約 **50 MB**
  - `public/videos`: 約 **24 MB**
  - `public/icons`: 約 **15 MB**
  - `public/fonts`: 約 **13 MB**

### 特に大きいファイル

- `public/icons/logo.svg`: 約 **14.7 MB**
- `public/videos/002.mp4`: 約 **11.9 MB**
- `public/videos/001.mp4`: 約 **8.1 MB**
- `public/fonts/NotoSerifJP-Bold.otf`: 約 **6.4 MB**
- `public/fonts/NotoSerifJP-Regular.otf`: 約 **6.2 MB**

### 実装上の観測

- `src/server/index.ts` で全レスポンスに `Cache-Control: no-store` を付与している
- 実際に `curl -I` すると、HTML だけでなく JS アセットにも `Cache-Control: no-store` が付いている
- `package.json` の `build:vite` が `cross-env NODE_ENV=development vite build` になっている
- `index.html` は `public/videos` 内の動画を **すべて `rel=preload` + `fetchPriority="high"`** で先読みする
- `src/client/components/foundation/Image/Image.tsx` は `<img loading="eager">` を固定している
- `src/client/components/product/ProductHeroImage/ProductHeroImage.tsx` は `canvaskit-wasm` を読み込み、画像を Data URL に変換してから表示している
- `public/icons/logo.svg` は SVG の中に `data:image...base64` を埋め込んでおり、ロゴとしては異常に大きい
- そのロゴは `Header` と `Footer` の両方で使われている
- `src/client/hooks/useFeatures.ts` / `useRecommendation.ts` は `useSuspenseQuery_experimental` を使い、`Providers.tsx` は `<Suspense fallback={null}>` になっている
- `src/client/utils/apollo_client.ts` は Apollo の fetch を同期 XHR (`XMLHttpRequest#open(..., false)`) で差し替えている
- `src/client/utils/apollo_client.ts` は `connectToDevTools: true`、全 query/mutate の `fetchPolicy: 'network-only'`、`queryDeduplication: false` を設定している
- `src/client/components/foundation/Anchor/Anchor.tsx` は生の `<a href>` を返しており、SPA 遷移になっていない箇所がある
- `src/client/components/order/OrderForm/OrderForm.tsx` は入力のたびに `cloneDeep(zipcodeJa)` を実行する
- `src/client/components/product/ProductMediaListPreviewer/MediaItem/loadThumbnail.ts` は動画サムネイルをクライアント側で `video` + `canvas` から生成している
- `src/server/graphql/product_resolver.ts` は `media` / `offers` / `reviews` を個別に `find()` しており、N+1 の疑いが強い
- `src/client/graphql/fragments.ts` / `queries.ts` は一覧系でも重い product fragment を使っている
- `src/client/hooks/useReviews.ts` はレビュー取得を **1 秒遅らせる**
- `src/client/utils/load_fonts.ts` は大きい OTF フォントを `FontFace.load()` で順番に読み込み、`display: 'block'` を使っている
- `src/server/graphql/index.ts` は GraphQL Landing Page plugin を有効にしている

---

## 4. 何について改善余地があると考え、どう調べ、どう結論づけるか

以下は、実際に着手するときの調査方針です。  
各項目で「何を疑うか」「どう調べるか」「どんな結論にするか」を固定しておきます。

### A. 初期表示のネットワーク転送量

#### 何について改善余地があると考えたか

この競技はホーム・商品詳細・購入手続き・404 の初期表示が採点されるので、**最初の表示に不要なバイトをどれだけ落とせるか**が重要です。  
このレポジトリは、初期表示前後に読み込む静的アセットが明らかに重すぎます。

特に疑う対象:

- `index.html` の動画 preload
- `Image.tsx` の `loading="eager"`
- `Header` / `Footer` で使う巨大 `logo.svg`
- `src/server/index.ts` の `Cache-Control: no-store`

#### こういう調べ方をする

1. `pnpm build` 後に `du` と `find` で大きいファイルを洗う  
2. `rg` で `preload` / `fetchPriority` / `loading="eager"` / `no-store` を検索する  
3. DevTools の Network で、最初の描画までに何が優先取得されているかを見る  
4. `curl -I` でキャッシュヘッダを確認する  
5. Lighthouse の LCP / FCP / TBT への影響を見る  

#### こういう結論ができた

- 巨大アセットを「最初から全部高優先度で取る」構成になっている
- 同じ巨大ロゴを全ページで使うのに、`no-store` によりブラウザキャッシュを生かせていない
- すべての画像を eager にしているため、画面外画像まで初回表示と競合する

#### 将来実行するときの方針

最初に着手するのはここです。

1. **`no-store` の適用範囲を分離する**
   - HTML や個人状態を含むレスポンスと、ハッシュ付き静的アセットを同じポリシーで返さない
   - 少なくとも `dist/assets/*` には長めのキャッシュを付ける余地がある
2. **巨大ロゴを作り直す**
   - `logo.svg` は「SVG として軽い」のではなく、「巨大な base64 画像を内包した SVG」なので、そのままでは危険
   - 純粋な SVG にするか、小さい画像に置き換えるかを最初に検討する
3. **動画 preload をやめる/絞る**
   - すべての動画を `fetchPriority="high"` で先読みするのは、LCP 候補と帯域を奪い合いやすい
4. **画像の lazy loading を導入する**
   - ただし LCP 画像まで一律に `lazy` にしない
   - ヒーロー画像だけは eager / `fetchpriority="high"` を検討し、画面外画像だけ lazy にする

---

### B. JS / WASM の初期実行コスト

#### 何について改善余地があると考えたか

ビルド結果が **JS 約 13.4 MB + WASM 約 6.8 MB** という時点で、初回ロードと TBT に大きな改善余地があります。  
さらに `vite.config.ts` では `minify: false`、`target: 'es2015'`、`assetsInlineLimit: 20480` と、現代ブラウザ向け最適化よりも「重くなりやすい」方向の設定が見えます。

#### こういう調べ方をする

1. `pnpm build` の出力サイズを毎回記録する  
2. `vite.config.ts` の build 設定を確認する  
3. `React.lazy` / `dynamic import()` で分割できそうなルートやコンポーネントを洗う  
4. 特に `ProductHeroImage.tsx` の CanvasKit 読み込みを、代替実装で置き換えられるか確認する  
5. 変更ごとに、ホームと商品詳細の TBT / LCP を見比べる  

#### こういう結論ができた

- 現状は「大きいものを最初にまとめて読む」構成に寄っている
- 単純な minify だけでも改善余地はあるが、**最大の勝ち筋は CanvasKit/WASM の撤去または遅延化**
- ルーティングは静的 import 中心なので、ホーム・商品詳細・購入手続き・404 の分割余地がある

#### 将来実行するときの方針

1. **CanvasKit を最優先で疑う**
   - 画像を Data URL に変換するためだけに 6.8 MB 級 WASM を持ち込む価値があるか、最初に問い直す
   - ネイティブの `<img>` / `<canvas>` / CSS で代替できるなら、そこが最優先
2. **ページ単位・機能単位で分割する**
   - `React.lazy` と Suspense を使って、404 や購入手続きなどを分離する
3. **Vite の build 設定を標準に寄せて再評価する**
   - minify を有効化
   - `target` を過剰に古くしない
   - `assetsInlineLimit` を必要以上に大きくしない

---

### C. データ取得とサーバー側の待ち時間

#### 何について改善余地があると考えたか

ユーザーフローの採点には TBT / INP があり、初期表示だけでなく**操作のたびの待ち時間**も効きます。  
GraphQL の resolver と query の構造を見ると、サーバー往復や DB アクセスが増えやすい形です。

#### こういう調べ方をする

1. `src/server/graphql/*.ts` を見て、親一覧からの N+1 を洗う  
2. `src/client/graphql/fragments.ts` / `queries.ts` を見て、一覧ページなのに詳細情報まで取っていないかを確認する  
3. レビュー表示やカート更新など、フロー中に複数回走る処理を優先して調べる  
4. 必要なら resolver ごとにクエリ数/処理時間のログを入れて、変更前後を比較する  

#### こういう結論ができた

- `product_resolver.ts` は `media` / `offers` / `reviews` を商品ごとに個別取得しており、N+1 が起きやすい
- `ProductWithReviewFragment` を多用していて、一覧でもレビューを背負い込みやすい
- `useReviews.ts` の 1 秒待機は「サーバー負荷が怖い」ことの表れで、根本の負荷が残ったまま UI だけ遅くしている

#### 将来実行するときの方針

1. **一覧用 fragment と詳細用 fragment を分ける**
   - 一覧では reviews まで持たない
2. **resolver を batch/join する**
   - DataLoader か eager loading で DB round trip を減らす
3. **その後で 1 秒タイマーを外す**
   - 先に timer だけ外すと、サーバー負荷がそのまま露出する可能性が高い

---

### D. フォント読み込みと route 固有の描画ブロック

#### 何について改善余地があると考えたか

404 と購入完了ページでは Noto Serif JP の表示要件があります。  
ただし今の実装は「見た目を守る代わりに、巨大 OTF をブロッキングに読んでページ全体を待たせる」構成になっています。

#### こういう調べ方をする

1. `public/fonts` のサイズを確認する  
2. `src/client/utils/load_fonts.ts` と利用箇所を読む  
3. DevTools で 404 / 購入完了ページのフォント読み込みと表示タイミングを見る  
4. 見た目の差分をスクリーンショット比較で確認する  

#### こういう結論ができた

- OTF 2 本だけで約 12.6 MB ある
- `display: 'block'` かつ `loadFonts()` 完了まで `null` を返しているため、ページ表示自体が止まりやすい
- ただしチェックリスト上、**このフォントを消すだけではダメ**

#### 将来実行するときの方針

1. **WOFF2 化と subset 化を優先する**
2. **必要なページだけで読み込む**
3. **`font-display` を `swap` / `fallback` / `optional` で比較する**
4. **見た目要件を満たすことを最後に目視確認する**

これは重要ですが、ホームや商品詳細の初期表示に直接効く改善よりは後ろに置きます。

---

### E. 二次候補: まだ大きいが、最初の着手点ではないもの

以下は改善余地がありそうですが、上の大きいボトルネックの後で十分です。

- `src/client/polyfill/install.ts` の無条件 polyfill 読み込み
- `@emotion/css` / `styled-components` の混在
- ルートごとのコード分割不足
- `vite.config.ts` の細かい build チューニング

この順番にした理由は、**まず「数 MB〜数十 MB 単位」で落とせるものを先に取るべき**だからです。

---

### F. 公開実装・参加記を見て後から追加したチェック項目

以下は、**公開されている解答例・参加記を見て後追いで補強したチェックリスト**です。  
元の仮説づくりの思考過程には混ぜず、「後から確認すると取りこぼしに気づきやすい項目」として扱います。

#### 1. 本番ビルドが本当に production 相当になっているか

- このレポジトリでは `package.json` の `build:vite` / `start:client` が `NODE_ENV=development` になっている
- `pnpm build` のログでも `react-jsx-dev-runtime.development.js` などが見える
- **いつ気づきそうか:** 最初に `package.json` とビルドログを見る段階
- **なぜ効きそうか:** dev build のままだと JS サイズ・実行コストの両方で不利

これは公開実装でもかなり早い段階で手が入っていたので、**巨大アセットと並ぶ初手候補**に入れてよいです。

#### 2. `Suspense` によって「何も出ない待ち方」になっていないか

- `src/client/hooks/useFeatures.ts` / `useRecommendation.ts` は `useSuspenseQuery_experimental`
- `src/client/components/application/Providers/Providers.tsx` は `<Suspense fallback={null}>`
- **いつ気づきそうか:** 最初の Lighthouse / FCP 計測か、hooks を読んだ段階
- **なぜ効きそうか:** SSR していない SPA でこれをやると、データ取得完了まで空白時間を作りやすい

ホームの「何も表示されるまで遅い」を見たら、ネットワークサイズだけでなくここも疑います。

#### 3. GraphQL 通信が同期 XHR でメインスレッドを止めていないか

- `src/client/utils/apollo_client.ts` で `XMLHttpRequest#open(method, uri, false)` を使っている
- **いつ気づきそうか:** API client を読むとき、または DevTools の waterfall / TBT を見たとき
- **なぜ効きそうか:** 通信が直列化しやすく、かつメインスレッドを塞ぐので TBT / LCP / INP に効きやすい

これは公開参加記でもかなり効いた変更として扱われており、**自分の観測だけでも強く疑う価値がある項目**です。

#### 4. SPA 遷移になっていないことで、ユーザーフローごとにフルリロードしていないか

- `src/client/components/foundation/Anchor/Anchor.tsx` は生の `<a>` を返す
- **いつ気づきそうか:** ユーザーフローを DevTools で流したとき、またはナビゲーション実装を読んだとき
- **なぜ効きそうか:** ログイン・商品詳細・購入手続きへの移動で毎回フルリロードに近いコストを払い、ユーザーフロー採点を落としやすい

特にこの競技はフロー採点があるので、**ページ単体スコアを詰めた後に効いてくる**というより、かなり早い段階で見る価値があります。

#### 5. フォームの入力ホットパスに重い処理が残っていないか

- `src/client/components/order/OrderForm/OrderForm.tsx` は入力のたびに `cloneDeep(zipcodeJa)` を実行する
- **いつ気づきそうか:** 購入フローの INP を見たとき、またはフォーム入力を軽く触って重さを感じたとき
- **なぜ効きそうか:** 注文フローの入力体験を直接悪化させる

この手の問題は初期表示の改善後に気づきやすいですが、**フロー採点を詰める段階では優先度が上がる**と考えます。

#### 6. 動画サムネイルをクライアントで生成していないか

- `src/client/components/product/ProductMediaListPreviewer/MediaItem/loadThumbnail.ts` は `video` と `canvas` でサムネイルを生成している
- **いつ気づきそうか:** 商品詳細ページのメディア周りを読んだとき、または CPU profile を見たとき
- **なぜ効きそうか:** 動画取得と canvas 描画が商品詳細ページの初期負荷に乗る

公開参加記では「動画は WebM 化 + サムネイル事前生成」が有効だったので、**動画 preload を消した後の次の一手**として見やすいです。

#### 7. 静的アセットを圧縮配信しているか

- 現在のサーバー実装には gzip / brotli 圧縮が見当たらない
- **いつ気づきそうか:** `curl -I` や DevTools headers を見たとき、またはデプロイ戦略を考える段階
- **なぜ効きそうか:** JS/CSS/JSON/テキスト系レスポンスの転送量を横断的に下げられる

コードだけでなく、**配信方法でもスコアが上がる**ことを公開実装は示していました。  
レギュレーション上も、無料範囲なら CDN や配信先変更は選択肢に入ります。

#### 8. 大物を片付けた後に、まだ削れる依存を残していないか

- 現リポジトリには `react-helmet`、`lodash`、`Recoil`、`Formik`、`zod` などの「動くが重め」な候補が残っている
- **いつ気づきそうか:** bundle analysis を回した後、もしくは大きいボトルネックを片付けた後半戦
- **なぜ効きそうか:** 単体では中規模だが、積み上げると JS サイズと実行コストを削れる

これは初手ではないですが、公開実装では実際に後半の積み上げとして効いていました。

#### 9. 開発用の機能や強すぎる fetch 設定を本番に残していないか

- `src/server/graphql/index.ts` は GraphQL Landing Page plugin を有効にしている
- `src/client/utils/apollo_client.ts` は `connectToDevTools: true`、全リクエスト `network-only`、`queryDeduplication: false`
- **いつ気づきそうか:** 大きいボトルネックを片付けたあとに bootstrapping 周りを見直す段階
- **なぜ効きそうか:** 単体では決定打ではなくても、本番では不要な処理・再取得・無駄な設定が残っている可能性がある

公開参加記でも GraphQL Playground の無効化が最後の調整に入っていたので、**後半戦の確認項目**として残しておく価値があります。

---

## 5. 実行順序の提案

自分が実際に着手するなら、この順番で進めます。

1. **基準値を記録する**
   - Lighthouse で 4 ページ + 4 フロー
   - `pnpm build` の出力サイズ
   - `curl -I` のキャッシュヘッダ
2. **ネットワークの無駄を消す**
    - `no-store` の見直し
    - 巨大ロゴの置き換え
    - 動画 preload の削減
    - 画面外画像の lazy load
    - gzip / brotli など配信圧縮の確認
3. **まず accidental な重さを外す**
    - `NODE_ENV=development` ビルドの解消
    - `useSuspenseQuery_experimental` + `fallback={null}` の見直し
    - 同期 XHR の撤去
4. **JS/WASM を削る**
    - CanvasKit の置換/遅延化
    - route 単位の code splitting
    - minify と target の見直し
5. **ユーザーフローのホットパスを削る**
    - raw `<a>` によるフルリロードの見直し
    - `zipcode-ja` まわりの入力処理軽量化
    - 動画サムネイルの事前生成
6. **GraphQL / DB の往復を減らす**
    - fragment 分離
    - N+1 解消
    - timer 除去
7. **フォント最適化**
    - WOFF2 / subset / `font-display`
8. **最後に bundle diet を詰める**
    - `react-helmet` / `lodash` / `Recoil` / `Formik` / `zod` の見直し
9. **毎回、採点対象とチェックリストを回して戻りがないか確認する**

---

## 6. 今回参照した公開ドキュメント

### 採点・制約

- SCORING.md  
  https://github.com/CyberAgentHack/web-speed-hackathon-2023-scoring-tool/blob/main/docs/SCORING.md
- REGULATION.md  
  https://github.com/CyberAgentHack/web-speed-hackathon-2023-scoring-tool/blob/main/docs/REGULATION.md
- CHECKLIST.md  
  https://github.com/CyberAgentHack/web-speed-hackathon-2023-scoring-tool/blob/main/docs/CHECKLIST.md

### ビルド・コード分割

- Vite build options  
  https://vite.dev/config/build-options
- React `lazy`  
  https://react.dev/reference/react/lazy
- MDN Lazy loading  
  https://developer.mozilla.org/en-US/docs/Web/Performance/Lazy_loading

### 画像・動画

- web.dev: Browser-level image lazy loading  
  https://web.dev/articles/browser-level-image-lazy-loading
- web.dev: Image performance  
  https://web.dev/learn/performance/image-performance
- web.dev: Video performance  
  https://web.dev/learn/performance/video-performance
- MDN: `<img>` `loading`  
  https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img#loading
- MDN: `<video>` `preload`  
  https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video#preload

### GraphQL / サーバー

- GraphQL.js: Solving the N+1 problem with DataLoader  
  https://www.graphql-js.org/docs/n1-dataloader/
- MDN: Cache-Control  
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control

### フォント

- web.dev: Optimize web fonts  
  https://web.dev/learn/performance/optimize-web-fonts
- MDN: `font-display`  
  https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display

### 公開実装・参加記

- sor4chi/zenn: `Web Speed Hackathon 2023 で3位になり損ねた話` の記事ファイル  
  https://github.com/sor4chi/zenn/blob/875b1ceea2fe9a8fd8c108a92abf0b2b08aa1132/articles/7e060938f72073.md
- nakamuraitsuki/wsh2023-practice-2025  
  https://github.com/nakamuraitsuki/wsh2023-practice-2025

---

## 7. 最後に

このレポジトリで最初に狙うべきなのは、細かい micro-optimization ではなく、**最初から読みすぎているものを止めること**です。  
特に「巨大ロゴ」「動画 preload」「画像 eager load」「CanvasKit WASM」「静的アセットへの `no-store`」に加えて、「`NODE_ENV=development` のままの build」「同期 XHR」「`Suspense` による空白待ち」「raw `<a>` によるフルリロード」は、変更 1 回あたりのリターンが大きいので、ここから始めるのが最も再現性の高い攻め方だと考えます。

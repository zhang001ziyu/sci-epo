/** Model instructions for the script logic ledger. Server-only. The model fills slots; the program decides findings. */
import type { Revision } from '../types';
import { studioIntro } from './formatPrompts';
import { actionRefs } from './blocking';
import { scriptLanguage } from './languages';
import { scriptLines } from './scriptLines';

export const LOGIC_GUIDANCE = `
你是剧本逻辑核对员。你的任务不是评价好坏，而是按正文如实填一张账，后面由程序判断哪里断了。只依据 user.scenes 的正文和 user.brief；梗概和人物小传里写了、正文里没写的东西，不算观众知道。
行号写成“场景编号:行号”，例如 s2:12，行号就是 user.scenes 里每行的 n。找不到就写 null，不要猜一个行号凑数。宁可写 null，也不要替剧本圆。

1. offscreen：只通过手机消息、电话、便条、订单备注出现、本人不在场的人物。她的每一条消息都列一项，messageRef 是消息出现的那一行。claims 列出这条消息说明她知道的每一件事（包括她怎么知道该提醒什么、她知道某物在哪、她知道此刻屋里发生了什么）。每件事的来源 sourceKind：
   - self：关于她自己的事（她在哪、她想要什么）；
   - present：她当时在场；told：之前有人告诉过她（sourceRef 写告诉她的那一行；消息本身明确写出她是怎么知道的，例如“他刚发短信跟我说……”“邻居打电话告诉我……”，sourceRef 就写这条消息那一行。只是说出这件事、没说怎么知道的，不算）；sees：她能看到画面，比如收到了照片或视频（sourceRef 写发照片的那一行）；earlier：正文前面交代过她知道（sourceRef 写那一行）；
   - history：故事开始之前就一直是这样、她凭自己过去和这个人或这个地方的经历就会知道的事（比如她以前住在那里，知道备用钥匙放在哪；家人多年的老毛病、老习惯），而且正文或 user.brief 交代了她和对方的这层关系。此刻、今晚、刚才正在发生的事永远不算 history；
   - brief：user.brief 明确写着她知道这件事（只写了人物关系不算：多年没见面的亲人，不代表知道对方家里此刻的事）；
   - none：正文里找不到来源。她不在场又没有收到任何画面，却在关键时刻说出现场正在发生的事，就是 none。
2. ending：ref 是结尾那一行，question 用一句话写结尾留给观众的问题。dependsOn 列出结尾成立所依赖的道具、规则、人物关系和事实，firstRef 写它在正文里第一次出现的那一行；只写在 brief 里、正文没出现的写 null。人物关系也要算：结尾的分量如果靠“他们是亲兄弟”，而正文没有一句台词或画面说出来，firstRef 就是 null。
3. setups：观众会等下文的线索：暗号、钥匙、钱、证物、信件、药、承诺、加价、特别的物件。只列满足其一的：人物注意到它、拿起它、说到它，或者正文特意点出它不寻常。只是交代环境或外观的描写（灯光、旧家具、衣服、某样东西上的污渍或划痕）不列，除非有人物注意到它。某样东西身上的细节（比如信封上的污渍）算作那样东西的一部分，只列那样东西，不单独列细节。payoffRef 写它后来被用上或有了下文的那一行，没有就 null；bearsOnEnding 写它是否直接指向结尾的那个问题。
4. instructions：违背常理的要求或做法，比如“让人半夜千万别开灯”，却不说为什么。reasonRef 写正文里给出理由的那一行，没人给理由也没人问，就写 null。
5. sightings：人物看见、发现、读到推动剧情的东西的每一行。visible：按正文写的位置和空间，她在那里能不能看见（yes、no、unclear），why 用一句中文说明。比如站在门口，看不到锁在抽屉里的东西。
6. protagonist 写主角的名字。choices 只列主角亲自做出、本可以不做、要付出她在乎的代价（钱、安全、工作、关系）、并且改变了接下来发生什么的选择。照吩咐办事、走路、开门、看手机、被动看到东西都不算。没有就写空列表。
7. blocking：人物站在哪、东西在哪、谁手里拿着什么。程序据此判断“够不够得着、有没有走过去”，并把每一行开始时的状态交给分镜和视频。只照正文记，不要替剧本补动作。
   - sets：每个地点一份固定布局，id 写 set1、set2……，scenes 列出发生在这里的场景编号（每一场都要归到一个布局里），zones 列出属于这里的区域。en 用两三句英文写清这个地方的固定陈设和它们的相对位置（例如门在哪面墙、沙发对着什么、厨房在门的哪一侧、桌子在哪里），后面所有镜头都按这一份搭景，所以要和正文写到的位置一致；正文没写的，按这种地方最常见的样子补，但不要和正文冲突。
   - zones：人物会待的区域，id 写 z1、z2……。一个区域就是站在那里伸手、跨一步能碰到的范围：同一间屋子里隔开几步的角落要分开（比如沙发旁、灶台旁），但门外、门口、门槛是同一个区域，不要拆开。name 用中文；en 用能接在 is 后面的英文介词短语，例如 "by the front door"、"in the armchair by the window"。
   - things：人物会拿、放、递、碰、打开、点燃、撕开的东西，id 写 t1、t2……。name 用中文，en 用英文名词短语（例如 "a brass key"）。ref 写它第一次出现的那一行；zone 写它一开始所在的区域，或者 holder 写一开始拿着它的人（只写一个，不知道就都写 null）。门、窗这类连在两个区域之间的东西，zone 写 null。不在人手里的东西，placement 用能接在 is 后面的英文短语写它具体怎么放着，例如 "lying on the coffee table"、"hidden under the doormat"、"inside a closed kitchen drawer"，正文写了就照正文，没写就写最自然的放法。同一种东西的不同件要分开：一整盒和从盒里抽出的一支是两样东西；火苗、亮光是那样东西的状态，不是另一样东西。
   - lines：user.blockingLines 里的每一个行号都要有一项，按顺序，一个不漏。每项的 events 列出这一行里改变人物位置、姿势、持物、身体状况的动作，以及每个直接对东西动手的动作，同一行有几个就按先后列几项；这一行只是神情、目光、声音、环境或屏幕上的字，没有这类动作，就写 "events": []。kind：
     at：人物在这一场第一次出现时的位置（zone）和姿势（posture）。只在每场第一次出现时用一次；之后位置变了，必须是正文里有 move、stand 或 sit。
     move：走到另一个区域（zone 必填）。人物从门外进来也是 move。
     stand、sit：站起来、坐下（sit 可写坐到哪个区域）。正文明确写站起来才算 stand；撑起上身、挺直腰不算。
     take：拿起或接过 thing。put：把 thing 放下，zone 写放到哪个区域（放在身边就写 null）。give：把 thing 递给 to。
     use：直接对 thing 动手：碰、按、打开、点燃、撕开、把手里的东西凑到它上面。只是看、拍照、指着、对它说话，都不算 use，不要列。with 写用来做这件事的、手里的东西（没有就 null）；state 写动作之后 thing 的状态，用英文短语，例如 "lit"、"open"、"torn"，没有变化写 null。
     put 和 use 改变了东西的放法时（放到桌上、掀开盖着它的东西），placement 写之后的放法（英文短语），没有变化写 null。
     condition：人物身上留下、后面镜头也要看得见的变化：受伤、烫伤、流血、衣服湿透或撕破、脸上的泥。state 用能接在 has 后面的英文名词短语，例如 "a burned right palm"、"rain-soaked clothes"。recover：这种变化结束（包扎好、换了衣服），state 写和 condition 一字不差的那个短语。一时的表情、出汗、发抖不算。
     posture 只能是 standing、sitting、lying、kneeling，不是 at 就写 null。who 写剧本里的人名。不需要的字段写 null。
   逐行填写时注意：凡是人物用手或手里的东西碰到、凑向、伸向、举到某样东西跟前的行（例如“把火苗凑向某物”），都要有一项 use，哪怕动作没做完。
   正文没写走过去，就不要列 move；正文没写拿起，就不要列 take。宁可让程序报出问题，也不要为了说得通补一个正文里没有的动作。
8. premises：常识核对。blocking.things 里每一样不在人手里的东西都要有一项（thingId 写它的编号），另外加上剧情依赖、但不是具体物件的情况（比如某人一个人住、门没锁），thingId 写 null。每项回答：placement 用中文写它在哪、怎么放着；placedBy 写谁放的（不知道写 null）；common：普通观众看到它这样放，会不会觉得理所当然、不需要解释；reasonRef：正文给出这样放的理由的那一行，没有写 null；plausible：按这个人的意图和日常常识，这样放合不合理（yes、no、unclear）；why 用一句中文说明。
   判断时站在放东西的人的立场想，不站在编剧的立场想：一样东西如果只是为了让观众或别的人物知道某件事才出现在那里（比如恰好摆着写了名字的遗像、贴着说明一切的便条），而放它的人自己并没有理由这样放，就判 no。想藏起来的东西（秘密、证据、钱、钥匙）不会放在别人一进门就看见的地方；要销毁、要用的东西会放在手边；东西会受到重力、粘性、天气这些常识的约束，不会凭空粘在、立在、挂在做不到的地方；一样东西不会无缘无故出现在两个地方。不要因为剧情需要就判 yes。
9. conduct：推动剧情的每个关键做法（藏、销毁、闯入、隐瞒、冒险、违背要求、伤害自己或别人），以及 blocking 里每一个 take、put、give、use 动作所在的行（每行一项），列出 who、ref、action（中文），common：普通观众会不会觉得这个人这样做理所当然；reasonRef：正文给出动机的那一行，没有写 null；plausible：这个人在这种处境、以他的性格和目的，会不会这样做（yes、no、unclear）；why 用一句中文说明。如果有明显更简单、更安全的做法而人物没选，又没有理由，就判 unclear 或 no。
   同时检查这个动作在物理上能不能做到：按 blocking 里人和东西此刻的位置、放法、高度和朝向，以及他手里已经拿着什么（一只手拿着东西就只剩一只手），这个动作能不能这样完成。例如东西在墙上或竖着的面上，就不能把它压在台面上；隔着柜台够不到的东西，就不能一把抓住。做不到就判 no，why 写清哪里对不上。
`.trim();

export function buildLogicMessages(revision: Revision): {role: 'system' | 'user'; content: string}[] {
  const brief = revision.context.brief;
  const format = '{"protagonist":"主角名","offscreen":[{"character":"人名","messageRef":"s2:12","claims":[{"fact":"她知道的事","sourceKind":"self|history|present|told|sees|earlier|brief|none","sourceRef":"s1:3 或 null"}]}],"ending":{"ref":"s2:21","question":"结尾的问题","dependsOn":[{"thing":"打火机","kind":"prop|rule|relationship|fact","firstRef":"s2:21 或 null"}]},"setups":[{"thing":"铜钥匙","ref":"s1:5","payoffRef":null,"bearsOnEnding":false}],"instructions":[{"text":"别开灯","ref":"s1:3","reasonRef":null}],"sightings":[{"who":"人名","what":"看见的东西","ref":"s2:14","visible":"yes|no|unclear","why":"一句中文说明"}],"choices":[{"ref":"s1:9","choice":"主角的选择","cost":"她付出的代价"}],"blocking":{"sets":[{"id":"set1","name":"地点名","en":"Fixed layout in English: fixtures and where they stand relative to each other.","scenes":["s1"],"zones":["z1"]}],"zones":[{"id":"z1","name":"门口","en":"by the front door"}],"things":[{"id":"t1","name":"铜钥匙","en":"a brass key","ref":"s1:5","zone":"z1","holder":null,"placement":"hidden under the doormat"}],"lines":[{"ref":"s1:1","events":[{"who":"人名","kind":"at|move|stand|sit|take|put|give|use|condition|recover","zone":"z1 或 null","posture":"standing|sitting|lying|kneeling 或 null","thing":"t1 或 null","with":"t2 或 null","to":"人名 或 null","state":"英文短语 或 null","placement":"英文短语 或 null"}]},{"ref":"s1:2","events":[]}]},"premises":[{"thingId":"t1","name":"铜钥匙","ref":"s1:5","placement":"压在门口的脚垫下","placedBy":"人名 或 null","common":true,"reasonRef":null,"plausible":"yes|no|unclear","why":"一句中文说明"}],"conduct":[{"who":"人名","ref":"s1:9","action":"中文写他做了什么","common":false,"reasonRef":"s1:8 或 null","plausible":"yes|no|unclear","why":"一句中文说明"}]}';
  return [
    {role: 'system', content: `${studioIntro(brief, scriptLanguage(revision))}\n${LOGIC_GUIDANCE}\n输出格式：${format}。fact、question、why、choice、cost、action 用简体中文写。只返回这一个 JSON 对象。`},
    {role: 'user', content: JSON.stringify({
      task: '按正文填写剧本逻辑账。',
      brief: {characters: brief.characters, worldRules: brief.worldRules, premise: brief.premise},
      scenes: revision.scenes.map(s => ({id: s.id, heading: s.heading, lines: scriptLines(s.content).map((text, i) => ({n: i + 1, text}))})),
      blockingLines: actionRefs(revision),
    })},
  ];
}

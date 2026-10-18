"""Reviewed geographic labels. Business combinations are never inferred from geography."""
import re

STATE_NAMES = dict(zip(
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(),
    '阿拉巴马州 阿拉斯加州 亚利桑那州 阿肯色州 加利福尼亚州 科罗拉多州 康涅狄格州 特拉华州 哥伦比亚特区 佛罗里达州 佐治亚州 夏威夷州 爱达荷州 伊利诺伊州 印第安纳州 艾奥瓦州 堪萨斯州 肯塔基州 路易斯安那州 缅因州 马里兰州 马萨诸塞州 密歇根州 明尼苏达州 密西西比州 密苏里州 蒙大拿州 内布拉斯加州 内华达州 新罕布什尔州 新泽西州 新墨西哥州 纽约州 北卡罗来纳州 北达科他州 俄亥俄州 俄克拉何马州 俄勒冈州 宾夕法尼亚州 罗得岛州 南卡罗来纳州 南达科他州 田纳西州 得克萨斯州 犹他州 佛蒙特州 弗吉尼亚州 华盛顿州 西弗吉尼亚州 威斯康星州 怀俄明州'.split(),
))

def postal_code(value, country='US'):
    raw = '' if value is None else str(value).strip()
    if not raw:
        return ''
    if country == 'US':
        if re.fullmatch(r'\d{1,5}', raw):
            return raw.zfill(5)
        if re.fullmatch(r'\d{9}', raw):
            return raw[:5] + '-' + raw[5:]
        if not re.fullmatch(r'\d{5}-\d{4}', raw):
            return ''
    return raw
